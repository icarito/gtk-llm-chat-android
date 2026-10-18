package com.gtkllmchat.xmpp.omemo

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.whispersystems.libsignal.*
import org.whispersystems.libsignal.ecc.Curve
import org.whispersystems.libsignal.state.*
import org.whispersystems.libsignal.util.KeyHelper
import org.whispersystems.libsignal.protocol.CiphertextMessage
import org.whispersystems.libsignal.protocol.PreKeySignalMessage
import org.whispersystems.libsignal.protocol.SignalMessage
import org.json.JSONObject
import java.util.ArrayList
import java.util.HashMap
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.security.SecureRandom

class MySignalProtocolStore(
    internal var identityKeyPair: IdentityKeyPair,
    private val localRegistrationId: Int
) : SignalProtocolStore {
    val sessions = HashMap<SignalProtocolAddress, SessionRecord>()
    val preKeys = HashMap<Int, PreKeyRecord>()
    val signedPreKeys = HashMap<Int, SignedPreKeyRecord>()
    val trustedIdentities = HashMap<SignalProtocolAddress, IdentityKey>()

    override fun getIdentityKeyPair(): IdentityKeyPair = identityKeyPair
    override fun getLocalRegistrationId(): Int = localRegistrationId

    override fun saveIdentity(address: SignalProtocolAddress, identityKey: IdentityKey): Boolean {
        val existing = trustedIdentities[address]
        if (existing == null) {
            trustedIdentities[address] = identityKey
            return true
        }
        return false
    }

    override fun isTrustedIdentity(
        address: SignalProtocolAddress,
        identityKey: IdentityKey,
        direction: IdentityKeyStore.Direction?
    ): Boolean {
        // TOFU: trust the first identity we see, but never silently replace a
        // previously pinned identity. A changed key must fail the session
        // build instead of making encryption appear healthy.
        val trusted = trustedIdentities[address]
        return trusted == null || trusted == identityKey
    }

    override fun getIdentity(address: SignalProtocolAddress): IdentityKey? =
        trustedIdentities[address]

    override fun loadSession(address: SignalProtocolAddress): SessionRecord {
        return sessions[address] ?: SessionRecord()
    }

    override fun getSubDeviceSessions(name: String): List<Int> {
        val deviceIds = ArrayList<Int>()
        for (address in sessions.keys) {
            if (address.name == name) {
                deviceIds.add(address.deviceId)
            }
        }
        return deviceIds
    }

    override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) {
        sessions[address] = record
    }

    override fun containsSession(address: SignalProtocolAddress): Boolean {
        return sessions.containsKey(address)
    }

    override fun deleteSession(address: SignalProtocolAddress) {
        sessions.remove(address)
    }

    override fun deleteAllSessions(name: String) {
        val toRemove = ArrayList<SignalProtocolAddress>()
        for (address in sessions.keys) {
            if (address.name == name) {
                toRemove.add(address)
            }
        }
        for (address in toRemove) {
            sessions.remove(address)
        }
    }

    override fun loadPreKey(preKeyId: Int): PreKeyRecord {
        return preKeys[preKeyId] ?: throw InvalidKeyIdException("No prekey with ID $preKeyId")
    }

    override fun storePreKey(preKeyId: Int, record: PreKeyRecord) {
        preKeys[preKeyId] = record
    }

    override fun containsPreKey(preKeyId: Int): Boolean {
        return preKeys.containsKey(preKeyId)
    }

    override fun removePreKey(preKeyId: Int) {
        preKeys.remove(preKeyId)
    }

    override fun loadSignedPreKey(signedPreKeyId: Int): SignedPreKeyRecord {
        return signedPreKeys[signedPreKeyId] ?: throw InvalidKeyIdException("No signed prekey with ID $signedPreKeyId")
    }

    override fun loadSignedPreKeys(): List<SignedPreKeyRecord> =
        signedPreKeys.values.toList()

    override fun storeSignedPreKey(signedPreKeyId: Int, record: SignedPreKeyRecord) {
        signedPreKeys[signedPreKeyId] = record
    }

    override fun containsSignedPreKey(signedPreKeyId: Int): Boolean {
        return signedPreKeys.containsKey(signedPreKeyId)
    }

    override fun removeSignedPreKey(signedPreKeyId: Int) {
        signedPreKeys.remove(signedPreKeyId)
    }
}

class XmppOmemoModule : Module() {
    private var activeStore: MySignalProtocolStore? = null

    // Mismos nombres y firmas JS que el módulo RN anterior (sin el `promise`).
    // Los errores se lanzan como CodedException con el mismo código.
    override fun definition() = ModuleDefinition {
        Name("XmppOmemoModule")

        AsyncFunction("generateIdentityKeyPair") { generateIdentityKeyPair() }
        AsyncFunction("generatePreKeys") { count: Int -> generatePreKeys(count) }
        AsyncFunction("generateSignedPreKey") { _: Map<String, Any?>?, id: Int -> generateSignedPreKey(id) }
        AsyncFunction("resetSessions") { resetSessions() }
        AsyncFunction("createSession") { sessionAddress: String, _: Map<String, Any?>?, bundle: Map<String, Any?> ->
            createSession(sessionAddress, bundle)
        }
        AsyncFunction("encrypt") { sessionAddress: String, plaintextBase64: String -> encrypt(sessionAddress, plaintextBase64) }
        AsyncFunction("decrypt") { sessionAddress: String, ciphertext: Map<String, Any?> -> decrypt(sessionAddress, ciphertext) }
        AsyncFunction("serialize") { serialize() }
        AsyncFunction("deserialize") { stateJson: String -> deserialize(stateJson) }
        AsyncFunction("aesGcmEncrypt") { plaintext: String -> aesGcmEncrypt(plaintext) }
        AsyncFunction("aesGcmDecrypt") { k: String, iv: String, payload: String -> aesGcmDecrypt(k, iv, payload) }
    }

    private fun fail(code: String, e: Exception): Nothing =
        throw CodedException(code, e.message, e)

    private fun getOrInitStore(): MySignalProtocolStore {
        var s = activeStore
        if (s == null) {
            val identityKeyPair = KeyHelper.generateIdentityKeyPair()
            val registrationId = KeyHelper.generateRegistrationId(false)
            s = MySignalProtocolStore(identityKeyPair, registrationId)
            activeStore = s
        }
        return s
    }

    private fun generateIdentityKeyPair(): Map<String, Any?> {
        try {
            val pair = getOrInitStore().getIdentityKeyPair()
            return mapOf(
                "publicKey" to Base64.encodeToString(pair.publicKey.serialize(), Base64.NO_WRAP),
                "privateKey" to Base64.encodeToString(pair.privateKey.serialize(), Base64.NO_WRAP)
            )
        } catch (e: Exception) {
            fail("OMEMO_GEN_IDENTITY_ERR", e)
        }
    }

    private fun generatePreKeys(count: Int): List<Map<String, Any?>> {
        try {
            val store = getOrInitStore()
            return KeyHelper.generatePreKeys(1, count).map { record ->
                store.storePreKey(record.id, record)
                mapOf(
                    "id" to record.id,
                    "publicKey" to Base64.encodeToString(record.keyPair.publicKey.serialize(), Base64.NO_WRAP)
                )
            }
        } catch (e: Exception) {
            fail("OMEMO_GEN_PREKEYS_ERR", e)
        }
    }

    private fun generateSignedPreKey(id: Int): Map<String, Any?> {
        try {
            val store = getOrInitStore()
            val record = KeyHelper.generateSignedPreKey(store.getIdentityKeyPair(), id)
            store.storeSignedPreKey(record.id, record)
            return mapOf(
                "id" to record.id,
                "publicKey" to Base64.encodeToString(record.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                "signature" to Base64.encodeToString(record.signature, Base64.NO_WRAP),
                "timestamp" to record.timestamp.toDouble()
            )
        } catch (e: Exception) {
            fail("OMEMO_GEN_SIGNED_PREKEY_ERR", e)
        }
    }

    private fun resetSessions(): Boolean {
        try {
            getOrInitStore().sessions.clear()
            return true
        } catch (e: Exception) {
            fail("OMEMO_RESET_SESSIONS_ERR", e)
        }
    }

    private fun parseAddress(sessionAddress: String, code: String): SignalProtocolAddress {
        val parts = sessionAddress.split(":")
        if (parts.size != 2) {
            throw CodedException(code, "Invalid sessionAddress format. Expected 'jid:deviceId'", null)
        }
        return SignalProtocolAddress(parts[0], parts[1].toInt())
    }

    private fun Map<String, Any?>.int(key: String): Int = (this[key] as Number).toInt()

    private fun createSession(sessionAddress: String, bundleMap: Map<String, Any?>): Boolean {
        try {
            val store = getOrInitStore()
            val address = parseAddress(sessionAddress, "OMEMO_CREATE_SESSION_ERR")
            val builder = SessionBuilder(store, address)

            val registrationId = bundleMap.int("registrationId")
            val bundleDeviceId = bundleMap.int("deviceId")
            val preKeyId = if (bundleMap["preKeyId"] != null) bundleMap.int("preKeyId") else -1
            val preKeyPublic = (bundleMap["preKeyPublic"] as String?)?.let {
                Curve.decodePoint(Base64.decode(it, Base64.DEFAULT), 0)
            }

            val signedPreKeyId = bundleMap.int("signedPreKeyId")
            val signedPreKeyPublic = Curve.decodePoint(Base64.decode(bundleMap["signedPreKeyPublic"] as String, Base64.DEFAULT), 0)
            val signedPreKeySignature = Base64.decode(bundleMap["signedPreKeySignature"] as String, Base64.DEFAULT)
            val identityKey = IdentityKey(Base64.decode(bundleMap["identityKey"] as String, Base64.DEFAULT), 0)

            val preKeyBundle = PreKeyBundle(
                registrationId,
                bundleDeviceId,
                if (preKeyId != -1) preKeyId else 0,
                preKeyPublic,
                signedPreKeyId,
                signedPreKeyPublic,
                signedPreKeySignature,
                identityKey
            )

            builder.process(preKeyBundle)
            return true
        } catch (e: CodedException) {
            throw e
        } catch (e: Exception) {
            fail("OMEMO_CREATE_SESSION_ERR", e)
        }
    }

    private fun encrypt(sessionAddress: String, plaintextBase64: String): Map<String, Any?> {
        try {
            val store = getOrInitStore()
            val address = parseAddress(sessionAddress, "OMEMO_ENCRYPT_ERR")
            val cipher = SessionCipher(store, address)
            val ciphertextMessage = cipher.encrypt(Base64.decode(plaintextBase64, Base64.DEFAULT))
            return mapOf(
                "type" to ciphertextMessage.type,
                "body" to Base64.encodeToString(ciphertextMessage.serialize(), Base64.NO_WRAP)
            )
        } catch (e: CodedException) {
            throw e
        } catch (e: Exception) {
            fail("OMEMO_ENCRYPT_ERR", e)
        }
    }

    private fun decrypt(sessionAddress: String, ciphertextMap: Map<String, Any?>): String {
        try {
            val store = getOrInitStore()
            val address = parseAddress(sessionAddress, "OMEMO_DECRYPT_ERR")
            val cipher = SessionCipher(store, address)

            val type = ciphertextMap.int("type")
            val bodyBytes = Base64.decode(ciphertextMap["body"] as String, Base64.DEFAULT)

            val decryptedBytes = if (type == CiphertextMessage.PREKEY_TYPE) {
                cipher.decrypt(PreKeySignalMessage(bodyBytes))
            } else {
                cipher.decrypt(SignalMessage(bodyBytes))
            }
            return Base64.encodeToString(decryptedBytes, Base64.NO_WRAP)
        } catch (e: CodedException) {
            throw e
        } catch (e: Exception) {
            fail("OMEMO_DECRYPT_ERR", e)
        }
    }

    private fun serialize(): String {
        try {
            val store = getOrInitStore()
            val json = JSONObject()
            json.put("localRegistrationId", store.getLocalRegistrationId())

            val identityJson = JSONObject()
            identityJson.put("public", Base64.encodeToString(store.identityKeyPair.publicKey.serialize(), Base64.NO_WRAP))
            identityJson.put("private", Base64.encodeToString(store.identityKeyPair.privateKey.serialize(), Base64.NO_WRAP))
            json.put("identityKeyPair", identityJson)

            val preKeysJson = JSONObject()
            for ((id, record) in store.preKeys) {
                preKeysJson.put(id.toString(), Base64.encodeToString(record.serialize(), Base64.NO_WRAP))
            }
            json.put("preKeys", preKeysJson)

            val signedPreKeysJson = JSONObject()
            for ((id, record) in store.signedPreKeys) {
                signedPreKeysJson.put(id.toString(), Base64.encodeToString(record.serialize(), Base64.NO_WRAP))
            }
            json.put("signedPreKeys", signedPreKeysJson)

            val sessionsJson = JSONObject()
            for ((address, record) in store.sessions) {
                val key = "${address.name}:${address.deviceId}"
                sessionsJson.put(key, Base64.encodeToString(record.serialize(), Base64.NO_WRAP))
            }
            json.put("sessions", sessionsJson)

            val trustedJson = JSONObject()
            for ((address, identityKey) in store.trustedIdentities) {
                val key = "${address.name}:${address.deviceId}"
                trustedJson.put(key, Base64.encodeToString(identityKey.serialize(), Base64.NO_WRAP))
            }
            json.put("trustedIdentities", trustedJson)

            return json.toString()
        } catch (e: Exception) {
            fail("OMEMO_SERIALIZE_ERR", e)
        }
    }

    private fun deserialize(stateJson: String): Boolean {
        try {
            val json = JSONObject(stateJson)
            val localRegistrationId = json.getInt("localRegistrationId")

            val identityJson = json.getJSONObject("identityKeyPair")
            val pubBytes = Base64.decode(identityJson.getString("public"), Base64.DEFAULT)
            val privBytes = Base64.decode(identityJson.getString("private"), Base64.DEFAULT)
            val publicKey = IdentityKey(pubBytes, 0)
            val privateKey = Curve.decodePrivatePoint(privBytes)
            val identityKeyPair = IdentityKeyPair(publicKey, privateKey)

            val store = MySignalProtocolStore(identityKeyPair, localRegistrationId)

            if (json.has("preKeys")) {
                val preKeysJson = json.getJSONObject("preKeys")
                val keys = preKeysJson.keys()
                while (keys.hasNext()) {
                    val keyStr = keys.next()
                    val id = keyStr.toInt()
                    val recordBytes = Base64.decode(preKeysJson.getString(keyStr), Base64.DEFAULT)
                    store.preKeys[id] = PreKeyRecord(recordBytes)
                }
            }

            if (json.has("signedPreKeys")) {
                val signedPreKeysJson = json.getJSONObject("signedPreKeys")
                val keys = signedPreKeysJson.keys()
                while (keys.hasNext()) {
                    val keyStr = keys.next()
                    val id = keyStr.toInt()
                    val recordBytes = Base64.decode(signedPreKeysJson.getString(keyStr), Base64.DEFAULT)
                    store.signedPreKeys[id] = SignedPreKeyRecord(recordBytes)
                }
            }

            if (json.has("sessions")) {
                val sessionsJson = json.getJSONObject("sessions")
                val keys = sessionsJson.keys()
                while (keys.hasNext()) {
                    val keyStr = keys.next()
                    val parts = keyStr.split(":")
                    if (parts.size == 2) {
                        val name = parts[0]
                        val deviceId = parts[1].toInt()
                        val recordBytes = Base64.decode(sessionsJson.getString(keyStr), Base64.DEFAULT)
                        store.sessions[SignalProtocolAddress(name, deviceId)] = SessionRecord(recordBytes)
                    }
                }
            }

            if (json.has("trustedIdentities")) {
                val trustedJson = json.getJSONObject("trustedIdentities")
                val keys = trustedJson.keys()
                while (keys.hasNext()) {
                    val keyStr = keys.next()
                    val parts = keyStr.split(":")
                    if (parts.size == 2) {
                        val name = parts[0]
                        val deviceId = parts[1].toInt()
                        val recordBytes = Base64.decode(trustedJson.getString(keyStr), Base64.DEFAULT)
                        store.trustedIdentities[SignalProtocolAddress(name, deviceId)] = IdentityKey(recordBytes, 0)
                    }
                }
            }

            activeStore = store
            return true
        } catch (e: Exception) {
            fail("OMEMO_DESERIALIZE_ERR", e)
        }
    }

    private fun aesGcmEncrypt(plaintext: String): Map<String, Any?> {
        try {
            val keyBytes = ByteArray(16) // AES-128 key for OMEMO
            val ivBytes = ByteArray(12) // standard GCM IV is 12 bytes
            val secureRandom = SecureRandom()
            secureRandom.nextBytes(keyBytes)
            secureRandom.nextBytes(ivBytes)

            val secretKey = SecretKeySpec(keyBytes, "AES")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val spec = GCMParameterSpec(128, ivBytes)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, spec)

            val ciphertextAndTag = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val tagLength = 16
            if (ciphertextAndTag.size < tagLength) {
                throw IllegalStateException("AES-GCM output did not contain an authentication tag")
            }
            val ciphertextBytes = ciphertextAndTag.copyOfRange(0, ciphertextAndTag.size - tagLength)
            val authTag = ciphertextAndTag.copyOfRange(ciphertextAndTag.size - tagLength, ciphertextAndTag.size)
            // Legacy OMEMO encrypts K || authentication-tag with Signal and
            // puts only the ciphertext in <payload/>. Sending the tag as part
            // of payload is not interoperable with Gajim/Dino/oldmemo.
            val keyMaterial = keyBytes + authTag

            return mapOf("key" to Base64.encodeToString(keyMaterial, Base64.NO_WRAP), "iv" to Base64.encodeToString(ivBytes, Base64.NO_WRAP), "payload" to Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP))
        } catch (e: Exception) {
            fail("AES_GCM_ENCRYPT_ERR", e)
        }
    }

    private fun aesGcmDecrypt(keyBase64: String, ivBase64: String, payloadBase64: String): String {
        try {
            val keyMaterial = Base64.decode(keyBase64, Base64.DEFAULT)
            val ivBytes = Base64.decode(ivBase64, Base64.DEFAULT)
            val ciphertextBytes = Base64.decode(payloadBase64, Base64.DEFAULT)
            if (keyMaterial.size != 32) {
                throw IllegalArgumentException("Legacy OMEMO key material must contain a 16-byte key and 16-byte tag")
            }
            val keyBytes = keyMaterial.copyOfRange(0, 16)
            val authTag = keyMaterial.copyOfRange(16, 32)
            val payloadBytes = ciphertextBytes + authTag

            val secretKey = SecretKeySpec(keyBytes, "AES")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val spec = GCMParameterSpec(128, ivBytes)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)

            val decryptedBytes = cipher.doFinal(payloadBytes)
            return String(decryptedBytes, Charsets.UTF_8)
        } catch (e: Exception) {
            fail("AES_GCM_DECRYPT_ERR", e)
        }
    }
}
