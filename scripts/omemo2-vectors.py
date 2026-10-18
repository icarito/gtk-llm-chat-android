#!/usr/bin/env python3
"""Vectores e interop de src/omemo2 contra la referencia de Syndace (twomemo,
doubleratchet, x3dh, xeddsa).

  python scripts/omemo2-vectors.py gen      # escribe __tests__/omemo2/vectors.json
  python scripts/omemo2-vectors.py interop  # TS <-> librería, en vivo, ambos sentidos

Requiere:  python3 -m venv /tmp/omemo2-venv && /tmp/omemo2-venv/bin/pip install 'twomemo[xml]==2.1.0'
Las llaves fijas replican las de xat (tests/interop/*.py).
"""
import asyncio, hashlib, json, os, subprocess, sys, tempfile

import xeddsa
from doubleratchet import EncryptedMessage, Header
from doubleratchet.recommended import diffie_hellman_ratchet_curve25519
from doubleratchet.recommended.crypto_provider_impl import CryptoProviderImpl
from doubleratchet.recommended.crypto_provider import HashFunction
from x3dh import HashFunction as XHash, IdentityKeyFormat
from x3dh.base_state import BaseState
from x3dh.identity_key_pair import IdentityKeyPairSeed
from x3dh.models import BaseStateModel, IdentityKeyPairModel, SignedPreKeyPairModel
from x3dh.types import Header as XHeader, SecretType
import x3dh.base_state as xbs
from twomemo.twomemo import AEADImpl, DoubleRatchetImpl, MessageChainKDFImpl, RootChainKDFImpl
from twomemo.twomemo_pb2 import OMEMOAuthenticatedMessage, OMEMOKeyExchange, OMEMOMessage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DHR = diffie_hellman_ratchet_curve25519.DiffieHellmanRatchet
DOS = MAX_SKIP = 1000
CONST = DoubleRatchetImpl.MESSAGE_CHAIN_CONSTANT

A_SEED = bytes(range(32))
B_SEED = bytes([1]) * 32
B_SPK_PRIV = bytes([2]) * 32
B_PREKEY_PRIV = bytes([3]) * 32
A_EPHEMERAL = bytes([4]) * 32
AD = bytes(range(64))
SS = bytes(range(32))


def x_pub(priv): return xeddsa.priv_to_curve25519_pub(priv)
def ed_pub(seed): return xeddsa.priv_to_ed25519_pub(xeddsa.seed_to_priv(seed))
def sign(seed, msg): return xeddsa.ed25519_priv_sign(xeddsa.seed_to_priv(seed), msg)
def clamp(k):
    k = bytearray(k)
    k[0] &= 248; k[31] &= 127; k[31] |= 64
    return bytes(k)


def hx(d): return {k: (v.hex() if isinstance(v, bytes) else v) for k, v in d.items()}


class St(BaseState):
    def _publish_bundle(self, bundle): pass
    @staticmethod
    def _encode_public_key(key_format, pub): return pub


def b_state():
    model = BaseStateModel(
        identity_key=IdentityKeyPairModel(secret=B_SEED, secret_type=SecretType.SEED),
        signed_pre_key=SignedPreKeyPairModel(priv=B_SPK_PRIV, sig=sign(B_SEED, x_pub(B_SPK_PRIV)), timestamp=0),
        old_signed_pre_key=None,
        pre_keys=frozenset([B_PREKEY_PRIV]),
    )
    return St.from_model(model, IdentityKeyFormat.ED_25519, XHash.SHA_256, b"OMEMO X3DH")


def header_of(ct: bytes) -> Header:
    m = OMEMOMessage.FromString(OMEMOAuthenticatedMessage.FromString(ct).message)
    return Header(m.dh_pub, m.pn, m.n)


def em(ct: bytes) -> EncryptedMessage:
    return EncryptedMessage(header_of(ct), ct)


async def payload_vector():
    key = bytes(range(32))
    pt = "<envelope xmlns='urn:xmpp:sce:1'><content><body xmlns='jabber:client'>hola</body></content><rpad>xx</rpad></envelope>".encode()
    okm = await CryptoProviderImpl.hkdf_derive(HashFunction.SHA_256, 80, b"\0" * 32, b"OMEMO Payload", key)
    ct = await CryptoProviderImpl.aes_cbc_encrypt(okm[:32], okm[64:], pt)
    mac = (await CryptoProviderImpl.hmac_calculate(okm[32:64], HashFunction.SHA_256, ct))[:16]
    return hx({"key": key, "plaintext": pt, "payload": ct, "keyMaterial": key + mac})


async def gen():
    # Identidad
    spk_pub = x_pub(B_SPK_PRIV)
    ident = hx({
        "seed": A_SEED, "pub": ed_pub(A_SEED),
        "x25519Pub": xeddsa.ed25519_pub_to_curve25519_pub(ed_pub(A_SEED)),
        "x25519Secret": clamp(hashlib.sha512(A_SEED).digest()[:32]),
        "spkPub": spk_pub, "spkSig": sign(A_SEED, spk_pub),
    })
    # X3DH (activo A contra el bundle de B, efímera fija)
    b = b_state()
    class _S:
        @staticmethod
        def token_bytes(n): return A_EPHEMERAL[:n]
        @staticmethod
        def choice(seq): return list(seq)[0]
    xbs.secrets = _S()
    a = St.create(IdentityKeyFormat.ED_25519, XHash.SHA_256, b"OMEMO X3DH", identity_key_pair=IdentityKeyPairSeed(A_SEED))
    ss, ad, hdr = await a.get_shared_secret_active(b.bundle)
    ss_p, ad_p, _ = await b.get_shared_secret_passive(hdr)
    assert (ss, ad) == (ss_p, ad_p)
    x3 = hx({
        "aSeed": A_SEED, "bSeed": B_SEED, "bSpkPriv": B_SPK_PRIV, "bPrekeyPriv": B_PREKEY_PRIV, "aEphemeral": A_EPHEMERAL,
        "bSpkSig": sign(B_SEED, spk_pub), "ss": ss, "ad": ad,
        "headerIk": hdr.identity_key, "headerEk": hdr.ephemeral_key,
    })
    # Protobuf
    msg = OMEMOMessage(n=3, pn=200, dh_pub=bytes([7]) * 32, ciphertext=bytes([9]) * 40).SerializeToString()
    auth = OMEMOAuthenticatedMessage(mac=bytes([5]) * 16, message=msg).SerializeToString()
    kex = OMEMOKeyExchange(pk_id=300, spk_id=2, ik=ed_pub(A_SEED), ek=bytes([4]) * 32, message=OMEMOAuthenticatedMessage.FromString(auth)).SerializeToString()
    pb = hx({"message": msg, "authenticated": auth, "kex": kex})
    # Double Ratchet: la librería activa envía m0 (inicial), m1, m2, y después de
    # la respuesta de TS no se puede fijar nada: eso lo cubre `interop`.
    own = B_SPK_PRIV
    recipient = x_pub(own)
    plains = [bytes([0xA0 + i]) * 48 for i in range(3)]
    dr, ekm = await DoubleRatchetImpl.encrypt_initial_message(
        DHR, RootChainKDFImpl, MessageChainKDFImpl, CONST, DOS, MAX_SKIP, AEADImpl, SS, recipient, plains[0], AD)
    cts = [ekm.ciphertext]
    for p in plains[1:]:
        cts.append((await dr.encrypt_message(p, AD)).ciphertext)
    drv = {"ss": SS.hex(), "ad": AD.hex(), "ownRatchetPriv": own.hex(),
           "messages": [{"ciphertext": c.hex(), "plaintext": p.hex()} for c, p in zip(cts, plains)]}
    out = {"payload": await payload_vector(), "identity": ident, "x3dh": x3, "protobuf": pb, "dr": drv}
    path = os.path.join(ROOT, "__tests__", "omemo2", "vectors.json")
    json.dump(out, open(path, "w"), indent=2)
    print("escrito", path)


def jest(phase: int, d: str):
    env = dict(os.environ, OMEMO2_INTEROP_DIR=d, OMEMO2_PHASE=str(phase))
    r = subprocess.run(["npx", "jest", "__tests__/omemo2/interop.test.ts"], cwd=ROOT, env=env, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"jest fase {phase} falló:\n{r.stdout}\n{r.stderr}")


async def interop():
    d = tempfile.mkdtemp()
    jest(1, d)  # TS activo: X3DH + kex + m0,m1,m2
    t = json.load(open(os.path.join(d, "ts1.json")))
    b = b_state()
    k = OMEMOKeyExchange.FromString(bytes.fromhex(t["kex"]))
    ss, ad, _ = await b.get_shared_secret_passive(XHeader(
        identity_key=k.ik, ephemeral_key=k.ek, signed_pre_key=x_pub(B_SPK_PRIV), pre_key=x_pub(B_PREKEY_PRIV)))
    dr, p0 = await DoubleRatchetImpl.decrypt_initial_message(
        DHR, RootChainKDFImpl, MessageChainKDFImpl, CONST, DOS, MAX_SKIP, AEADImpl, ss, B_SPK_PRIV, em(k.message.SerializeToString()), ad)
    assert p0 == bytes.fromhex(t["plain"][0]), "m0"
    m1, m2 = (bytes.fromhex(x) for x in t["msgs"])
    assert await dr.decrypt_message(em(m2), ad) == bytes.fromhex(t["plain"][2]), "m2 (salteo)"
    assert await dr.decrypt_message(em(m1), ad) == bytes.fromhex(t["plain"][1]), "m1 (salteado)"
    print("TS -> librería: kex, X3DH, ratchet, claves salteadas OK")
    r = [bytes([0xC0 + i]) * 48 for i in range(2)]
    rc = [(await dr.encrypt_message(p, ad)).ciphertext for p in r]
    json.dump({"ad": ad.hex(), "ct": [c.hex() for c in rc], "plain": [p.hex() for p in r]}, open(os.path.join(d, "py.json"), "w"))
    jest(2, d)  # TS recibe r1, r0 (salteado) y responde m3 tras el paso DH
    t2 = json.load(open(os.path.join(d, "ts2.json")))
    assert await dr.decrypt_message(em(bytes.fromhex(t2["ct"])), ad) == bytes.fromhex(t2["plain"]), "m3 tras ratchet DH"
    print("librería -> TS (salteo + paso DH) y TS -> librería (continuación) OK")
    print("OMEMO2_INTEROP_OK")


if __name__ == "__main__":
    asyncio.run({"gen": gen, "interop": interop}[sys.argv[1]]())
