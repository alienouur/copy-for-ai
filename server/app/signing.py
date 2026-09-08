"""ECDSA P-256 signed license keys.

Key format: ``CFA1.<base64url(payload json)>.<base64url(raw r||s signature)>``
The extension verifies the signature offline with WebCrypto using the
embedded public JWK, so no server round-trip is needed after activation.
"""
import base64
import json
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

PREFIX = "CFA1"


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_private_key(pem: str) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError("LICENSE_PRIVATE_KEY must be an EC P-256 key")
    return key


def generate_private_key_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    nums = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": b64u(nums.x.to_bytes(32, "big")),
        "y": b64u(nums.y.to_bytes(32, "big")),
    }


def issue_key(key: ec.EllipticCurvePrivateKey, email: str, ref: str) -> str:
    payload = {"e": email.lower().strip(), "r": ref[-12:], "t": int(time.time())}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    der = key.sign(body, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{PREFIX}.{b64u(body)}.{b64u(raw)}"


def verify_key(key: ec.EllipticCurvePrivateKey, license_key: str) -> dict:
    prefix, body_b64, sig_b64 = license_key.strip().split(".")
    if prefix != PREFIX:
        raise ValueError("bad prefix")
    body = b64u_decode(body_b64)
    raw = b64u_decode(sig_b64)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key.public_key().verify(der, body, ec.ECDSA(hashes.SHA256()))
    return json.loads(body)
