"""Bot gateway credential encryption and account digest helpers.

The envelope format mirrors the gateway's local vault (AES-256-GCM,
base64 iv/tag/ciphertext) but binds the AAD to connection id, channel,
schema version and key version so ciphertext can never be replayed
across connections or channels.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from open_webui.env import BOT_GATEWAY_CREDENTIAL_MASTER_KEY

CREDENTIAL_SCHEMA_VERSION = 1
CREDENTIAL_AAD_PREFIX = 'ryanai-bot-credential-v1'
CREDENTIAL_DIGEST_PREFIX = 'ryanai-bot-credential-digest-v1'
CREDENTIAL_KEY_BYTES = 32
CREDENTIAL_IV_BYTES = 12
CHECKPOINT_SCHEMA_VERSION = 1
CHECKPOINT_AAD_PREFIX = 'ryanai-bot-checkpoint-v1'
SUPPORTED_CHANNELS = frozenset({'wechat', 'qq'})


class BotGatewayCredentialError(ValueError):
    """Raised when the master key or a credential envelope cannot be used safely.

    A decryption failure is a wrong master key or tampering, never a missing
    credential, so callers must surface it instead of silently ignoring it.
    """


def bot_gateway_credential_master_key() -> bytes:
    """Parse the credential master key into exactly 32 raw bytes.

    Accepts 64 hex characters or base64.  Anything else (including an empty
    value) raises BotGatewayCredentialError so the credential center fails
    closed instead of storing recoverable state.
    """
    # Prefer the live environment so test and secret-injection environments
    # can update configuration before a request. Envelope key versions still
    # require a controlled data migration before rotating the production key.
    value = os.getenv('BOT_GATEWAY_CREDENTIAL_MASTER_KEY', BOT_GATEWAY_CREDENTIAL_MASTER_KEY).strip()
    if not value:
        raise BotGatewayCredentialError('BOT_GATEWAY_CREDENTIAL_MASTER_KEY is not configured')
    if re.fullmatch(r'[a-fA-F0-9]{64}', value):
        key = bytes.fromhex(value)
    else:
        try:
            key = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise BotGatewayCredentialError(
                'BOT_GATEWAY_CREDENTIAL_MASTER_KEY must be 64 hex characters or base64'
            ) from exc
    if len(key) != CREDENTIAL_KEY_BYTES:
        raise BotGatewayCredentialError(
            'BOT_GATEWAY_CREDENTIAL_MASTER_KEY must decode to exactly 32 bytes'
        )
    return key


def _derive_key(purpose: str, key_version: int = 1) -> bytes:
    """Derive a purpose-specific key from the configured master key."""
    if key_version != 1:
        raise BotGatewayCredentialError(f'unsupported credential key version: {key_version}')
    return HKDF(
        algorithm=hashes.SHA256(),
        length=CREDENTIAL_KEY_BYTES,
        salt=None,
        info=f'ryanai-bot-gateway:{purpose}:v{key_version}'.encode(),
    ).derive(bot_gateway_credential_master_key())


def _normalize_channel(channel: str) -> str:
    normalized = channel.strip().lower() if isinstance(channel, str) else ''
    if normalized not in SUPPORTED_CHANNELS:
        raise BotGatewayCredentialError(f'unsupported bot channel: {channel!r}')
    return normalized


def _normalize_account_key(channel: str, account_key: str) -> str:
    normalized_channel = _normalize_channel(channel)
    if not isinstance(account_key, str):
        raise BotGatewayCredentialError('account identity key must be a string')
    normalized = account_key.strip()
    if not normalized:
        raise BotGatewayCredentialError('account identity key must not be empty')
    # QQ app IDs are numeric identifiers and leading zeroes are not meaningful.
    if normalized_channel == 'qq' and normalized.isascii() and normalized.isdigit():
        normalized = str(int(normalized))
    return normalized


def credential_account_digest(channel: str, account_key: str) -> str:
    """HMAC-SHA256 digest of a channel-scoped account key.

    Used for account uniqueness constraints without ever decrypting or
    scanning stored credentials.  The digest is not reversible.
    """
    channel = _normalize_channel(channel)
    account_key = _normalize_account_key(channel, account_key)
    key = _derive_key('account-digest')
    message = f'{CREDENTIAL_DIGEST_PREFIX}:{channel}:{account_key}'.encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def _credential_aad(connection_id: str, channel: str, key_version: int) -> bytes:
    channel = _normalize_channel(channel)
    return (
        f'{CREDENTIAL_AAD_PREFIX}:{connection_id}:{channel}:'
        f'schema_v{CREDENTIAL_SCHEMA_VERSION}:key_v{key_version}'
    ).encode()


def encrypt_bot_credentials(
    credentials: dict[str, Any],
    connection_id: str,
    channel: str,
    key_version: int = 1,
) -> dict[str, Any]:
    """Encrypt credentials into an AES-256-GCM envelope dict.

    The returned envelope contains version, key_version, schema_version and
    base64 iv/tag/ciphertext; the AAD binds it to the connection and channel.
    """
    if not isinstance(credentials, dict):
        raise BotGatewayCredentialError('credentials must be a JSON object')
    channel = _normalize_channel(channel)
    key = _derive_key('credential-encryption', key_version)
    iv = secrets.token_bytes(CREDENTIAL_IV_BYTES)
    plaintext = json.dumps(credentials, ensure_ascii=False).encode()
    # AESGCM.encrypt returns ciphertext with the 16-byte tag appended.
    sealed = AESGCM(key).encrypt(iv, plaintext, _credential_aad(connection_id, channel, key_version))
    ciphertext, tag = sealed[:-16], sealed[-16:]
    return {
        'version': 1,
        'key_version': key_version,
        'schema_version': CREDENTIAL_SCHEMA_VERSION,
        'iv': base64.b64encode(iv).decode(),
        'tag': base64.b64encode(tag).decode(),
        'ciphertext': base64.b64encode(ciphertext).decode(),
    }


def decrypt_bot_credentials(
    envelope: dict[str, Any],
    connection_id: str,
    channel: str,
) -> dict[str, Any]:
    """Decrypt an envelope previously produced by encrypt_bot_credentials.

    Any version mismatch, malformed encoding or AAD/tag mismatch (wrong master
    key or tampering) raises BotGatewayCredentialError.
    """
    if not isinstance(envelope, dict):
        raise BotGatewayCredentialError('invalid credential envelope')
    if envelope.get('version') != 1:
        raise BotGatewayCredentialError('unsupported credential envelope version')
    key_version = envelope.get('key_version')
    if not isinstance(key_version, int) or key_version < 1:
        raise BotGatewayCredentialError('invalid credential envelope key_version')
    if envelope.get('schema_version') != CREDENTIAL_SCHEMA_VERSION:
        raise BotGatewayCredentialError('unsupported credential envelope schema_version')
    try:
        iv = base64.b64decode(str(envelope.get('iv')), validate=True)
        tag = base64.b64decode(str(envelope.get('tag')), validate=True)
        ciphertext = base64.b64decode(str(envelope.get('ciphertext')), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BotGatewayCredentialError('invalid credential envelope encoding') from exc
    if len(iv) != CREDENTIAL_IV_BYTES:
        raise BotGatewayCredentialError('invalid credential envelope iv')
    aad = _credential_aad(connection_id, channel, key_version)
    try:
        plaintext = AESGCM(_derive_key('credential-encryption', key_version)).decrypt(
            iv, ciphertext + tag, aad
        )
    except Exception as exc:
        raise BotGatewayCredentialError(
            'credential decryption failed: wrong master key or tampered envelope'
        ) from exc
    try:
        credentials = json.loads(plaintext.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BotGatewayCredentialError('decrypted credential payload is not valid JSON') from exc
    if not isinstance(credentials, dict):
        raise BotGatewayCredentialError('decrypted credential payload is not an object')
    return credentials


def extract_account_key(channel: str, credentials: dict[str, Any]) -> str:
    """Return the identity key used for account uniqueness.

    qq credentials identify by app_id, wechat credentials by accountId.
    A missing key raises BotGatewayCredentialError.
    """
    channel = _normalize_channel(channel)
    if not isinstance(credentials, dict):
        raise BotGatewayCredentialError('credentials must be a JSON object')
    if channel == 'wechat':
        account_key = credentials.get('accountId', credentials.get('account_id'))
    elif channel == 'qq':
        # The public API uses snake_case while the legacy sidecar cache keeps
        # the official SDK's camelCase names. Accept both during migration so
        # an existing, live account is never mistaken for an invalid credential.
        account_key = credentials.get('app_id', credentials.get('appId'))
    if not account_key or not isinstance(account_key, str):
        raise BotGatewayCredentialError(
            f'channel {channel} credentials are missing the account identity key'
        )
    return _normalize_account_key(channel, account_key)


def encrypt_bot_checkpoint(payload: bytes, connection_id: str, key_version: int = 1) -> dict[str, Any]:
    """Encrypt a small opaque account checkpoint with a checkpoint-specific key."""
    if not isinstance(payload, bytes):
        raise BotGatewayCredentialError('checkpoint payload must be bytes')
    iv = secrets.token_bytes(CREDENTIAL_IV_BYTES)
    aad = f'{CHECKPOINT_AAD_PREFIX}:{connection_id}:schema_v{CHECKPOINT_SCHEMA_VERSION}:key_v{key_version}'.encode()
    sealed = AESGCM(_derive_key('checkpoint-encryption', key_version)).encrypt(iv, payload, aad)
    return {
        'version': 1,
        'key_version': key_version,
        'schema_version': CHECKPOINT_SCHEMA_VERSION,
        'iv': base64.b64encode(iv).decode(),
        'ciphertext': base64.b64encode(sealed).decode(),
    }


def decrypt_bot_checkpoint(envelope: dict[str, Any], connection_id: str) -> bytes:
    """Decrypt an opaque account checkpoint and authenticate its connection id."""
    try:
        key_version = int(envelope['key_version'])
        if envelope.get('version') != 1 or envelope.get('schema_version') != CHECKPOINT_SCHEMA_VERSION:
            raise ValueError('unsupported checkpoint envelope version')
        iv = base64.b64decode(str(envelope['iv']), validate=True)
        sealed = base64.b64decode(str(envelope['ciphertext']), validate=True)
        aad = f'{CHECKPOINT_AAD_PREFIX}:{connection_id}:schema_v{CHECKPOINT_SCHEMA_VERSION}:key_v{key_version}'.encode()
        return AESGCM(_derive_key('checkpoint-encryption', key_version)).decrypt(iv, sealed, aad)
    except Exception as exc:
        raise BotGatewayCredentialError('checkpoint decryption failed') from exc
