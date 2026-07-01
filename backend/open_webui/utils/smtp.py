import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from open_webui.config import (
    SMTP_USERNAME,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_PASSWORD,
    SMTP_SENT_FROM,
)
from open_webui.models.config import Config


def _cfg(key: str, default: str) -> str:
    value = Config.get_sync(key, default)
    return str(value or '')


def send_email(receiver: str, subject: str, body: str):
    smtp_username = _cfg('ui.smtp.username', SMTP_USERNAME)
    smtp_host = _cfg('ui.smtp.host', SMTP_HOST)
    smtp_port = _cfg('ui.smtp.port', SMTP_PORT)
    smtp_password = _cfg('ui.smtp.password', SMTP_PASSWORD)
    smtp_sent_from = _cfg('ui.smtp.sent_from', SMTP_SENT_FROM)

    message = MIMEMultipart()
    message['From'] = smtp_sent_from or smtp_username
    message['To'] = receiver
    message['Subject'] = subject
    message.attach(MIMEText(body, 'html'))

    port = str(smtp_port)
    if port == '587':
        server = smtplib.SMTP(smtp_host, int(port))
        server.starttls()
    elif port == '465':
        server = smtplib.SMTP_SSL(smtp_host, int(port))
    else:
        raise ValueError(f'Invalid SMTP port {port}')

    try:
        server.login(smtp_username, smtp_password)
        server.send_message(message)
    finally:
        server.quit()
