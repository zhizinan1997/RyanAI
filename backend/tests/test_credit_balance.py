import importlib.util
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from unittest import TestCase
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


class CreditBalanceTests(TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name, 'credits.db').as_posix()
        self.engine = create_engine(
            f'sqlite:///{database_path}',
            connect_args={'check_same_thread': False, 'timeout': 10},
        )
        sessions = sessionmaker(bind=self.engine)

        @contextmanager
        def get_db():
            with sessions() as db:
                yield db

        db_module = ModuleType('open_webui.internal.db')
        db_module.Base = declarative_base()
        db_module.get_db = get_db

        self.config_module = ModuleType('open_webui.models.config')
        self.config_module.Config = type('Config', (), {'get_sync': staticmethod(lambda key, default: default)})

        module_name = '_credit_balance_under_test'
        module_path = Path(__file__).parents[1] / 'open_webui' / 'models' / 'credits.py'
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        self.credits = importlib.util.module_from_spec(spec)
        with patch.dict(
            sys.modules,
            {
                module_name: self.credits,
                'open_webui.internal.db': db_module,
                'open_webui.models.config': self.config_module,
            },
        ):
            spec.loader.exec_module(self.credits)

        db_module.Base.metadata.create_all(self.engine)
        with get_db() as db:
            now = int(time.time())
            db.add(
                self.credits.Credit(id='balance', user_id='user', credit=Decimal('1'), created_at=now, updated_at=now)
            )
            db.commit()
        self.get_db = get_db

    def tearDown(self):
        self.engine.dispose()
        self.temp_dir.cleanup()

    def test_concurrent_debits_never_overdraw_or_log_stale_balances(self):
        credits = self.credits.CreditsTable()
        ready = threading.Barrier(2)
        initialize = credits.init_credit_by_user_id

        def start_together(user_id):
            result = initialize(user_id)
            ready.wait(timeout=10)
            return result

        credits.init_credit_by_user_id = start_together
        debit = self.credits.AddCreditForm(
            user_id='user',
            amount=Decimal('-1'),
            detail=self.credits.SetCreditFormDetail(desc='test debit'),
        )

        def charge():
            try:
                credits.add_credit_by_user_id(debit)
                return 200
            except HTTPException as error:
                return error.status_code

        with patch.dict(sys.modules, {'open_webui.models.config': self.config_module}):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: charge(), range(2)))

        self.assertCountEqual(results, [200, 403])
        with self.get_db() as db:
            balance = db.query(self.credits.Credit.credit).filter_by(user_id='user').scalar()
            logs = db.query(self.credits.CreditLog).all()
        self.assertEqual(balance, Decimal('0'))
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].credit, balance)

    def test_init_retries_after_another_request_created_the_credit_row(self):
        credits = self.credits.CreditsTable()
        original_get = credits.get_credit_by_user_id
        lookups = 0

        def concurrent_lookup(user_id):
            nonlocal lookups
            lookups += 1
            return None if lookups == 1 else original_get(user_id)

        credits.get_credit_by_user_id = concurrent_lookup
        credits.insert_new_credit = lambda user_id: None

        result = credits.init_credit_by_user_id('user')

        self.assertEqual(result.credit, Decimal('1'))
        self.assertEqual(lookups, 2)
