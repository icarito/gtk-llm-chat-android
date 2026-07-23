package com.gtkllmchat.xmpp.omemo

import android.util.Base64
import com.facebook.react.bridge.*
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

class XmppOmemoModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var activeStore: MySignalProtocolStore? = null

    override fun getName(): String = "XmppOmemoModule"

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

    @ReactMethod
    fun generateIdentityKeyPair(promise: Promise) {
        try {
            val store = getOrInitStore()
            val pair = store.getIdentityKeyPair()
            val map = Arguments.createMap()
            map.putString("publicKey", Base64.encodeToString(pair.publicKey.serialize(), Base64.NO_WRAP))
            map.putString("privateKey", Base64.encodeToString(pair.privateKey.serialize(), Base64.NO_WRAP))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("OMEMO_GEN_IDENTITY_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun generatePreKeys(count: Int, promise: Promise) {
        try {
            val store = getOrInitStore()
            val records = KeyHelper.generatePreKeys(1, count)
            val array = Arguments.createArray()
            for (record in records) {
                store.storePreKey(record.id, record)
                val map = Arguments.createMap()
                map.putInt("id", record.id)
                map.putString("publicKey", Base64.encodeToString(record.keyPair.publicKey.serialize(), Base64.NO_WRAP))
                array.pushMap(map)
            }
            promise.resolve(array)
        } catch (e: Exception) {
            promise.reject("OMEMO_GEN_PREKEYS_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun generateSignedPreKey(identityKeyPairMap: ReadableMap?, id: Int, promise: Promise) {
        try {
            val store = getOrInitStore()
            val pair = store.getIdentityKeyPair()
            val record = KeyHelper.generateSignedPreKey(pair, id)
            store.storeSignedPreKey(record.id, record)

            val map = Arguments.createMap()
            map.putInt("id", record.id)
            map.putString("publicKey", Base64.encodeToString(record.keyPair.publicKey.serialize(), Base64.NO_WRAP))
            map.putString("signature", Base64.encodeToString(record.signature, Base64.NO_WRAP))
            map.putDouble("timestamp", record.timestamp.toDouble())
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("OMEMO_GEN_SIGNED_PREKEY_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun createSession(sessionAddress: String, identityKeyPairMap: ReadableMap?, bundleMap: ReadableMap, promise: Promise) {
        try {
            val store = getOrInitStore()
            val parts = sessionAddress.split(":")
            if (parts.size != 2) {
                promise.reject("OMEMO_CREATE_SESSION_ERR", "Invalid sessionAddress format. Expected 'jid:deviceId'")
                return
            }
            val remoteJid = parts[0]
            val deviceId = parts[1].toInt()
            val address = SignalProtocolAddress(remoteJid, deviceId)
            val builder = SessionBuilder(store, address)

            val registrationId = bundleMap.getInt("registrationId")
            val bundleDeviceId = bundleMap.getInt("deviceId")
            val preKeyId = if (bundleMap.hasKey("preKeyId")) bundleMap.getInt("preKeyId") else -1
            val preKeyPublicBytes = if (bundleMap.hasKey("preKeyPublic") && !bundleMap.isNull("preKeyPublic")) {
                Base64.decode(bundleMap.getString("preKeyPublic"), Base64.DEFAULT)
            } else null

            val preKeyPublic = preKeyPublicBytes?.let { Curve.decodePoint(it, 0) }

            val signedPreKeyId = bundleMap.getInt("signedPreKeyId")
            val signedPreKeyPublicBytes = Base64.decode(bundleMap.getString("signedPreKeyPublic"), Base64.DEFAULT)
            val signedPreKeyPublic = Curve.decodePoint(signedPreKeyPublicBytes, 0)
            val signedPreKeySignature = Base64.decode(bundleMap.getString("signedPreKeySignature"), Base64.DEFAULT)

            val identityKeyBytes = Base64.decode(bundleMap.getString("identityKey"), Base64.DEFAULT)
            val identityKey = IdentityKey(identityKeyBytes, 0)

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
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("OMEMO_CREATE_SESSION_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun encrypt(sessionAddress: String, plaintextBase64: String, promise: Promise) {
        try {
            val store = getOrInitStore()
            val parts = sessionAddress.split(":")
            if (parts.size != 2) {
                promise.reject("OMEMO_ENCRYPT_ERR", "Invalid sessionAddress format. Expected 'jid:deviceId'")
                return
            }
            val remoteJid = parts[0]
            val deviceId = parts[1].toInt()
            val address = SignalProtocolAddress(remoteJid, deviceId)
            val cipher = SessionCipher(store, address)

            val rawBytes = Base64.decode(plaintextBase64, Base64.DEFAULT)
            val ciphertextMessage = cipher.encrypt(rawBytes)
            val map = Arguments.createMap()
            map.putInt("type", ciphertextMessage.type)
            map.putString("body", Base64.encodeToString(ciphertextMessage.serialize(), Base64.NO_WRAP))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("OMEMO_ENCRYPT_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun decrypt(sessionAddress: String, ciphertextMap: ReadableMap, promise: Promise) {
        try {
            val store = getOrInitStore()
            val parts = sessionAddress.split(":")
            if (parts.size != 2) {
                promise.reject("OMEMO_DECRYPT_ERR", "Invalid sessionAddress format. Expected 'jid:deviceId'")
                return
            }
            val remoteJid = parts[0]
            val deviceId = parts[1].toInt()
            val address = SignalProtocolAddress(remoteJid, deviceId)
            val cipher = SessionCipher(store, address)

            val type = ciphertextMap.getInt("type")
            val bodyBytes = Base64.decode(ciphertextMap.getString("body"), Base64.DEFAULT)

            val decryptedBytes = if (type == CiphertextMessage.PREKEY_TYPE) {
                cipher.decrypt(PreKeySignalMessage(bodyBytes))
            } else {
                cipher.decrypt(SignalMessage(bodyBytes))
            }
            promise.resolve(Base64.encodeToString(decryptedBytes, Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("OMEMO_DECRYPT_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun serialize(promise: Promise) {
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

            promise.resolve(json.toString())
        } catch (e: Exception) {
            promise.reject("OMEMO_SERIALIZE_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun deserialize(stateJson: String, promise: Promise) {
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
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OMEMO_DESERIALIZE_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun aesGcmEncrypt(plaintext: String, promise: Promise) {
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

            val map = Arguments.createMap()
            map.putString("key", Base64.encodeToString(keyMaterial, Base64.NO_WRAP))
            map.putString("iv", Base64.encodeToString(ivBytes, Base64.NO_WRAP))
            map.putString("payload", Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("AES_GCM_ENCRYPT_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun aesGcmDecrypt(keyBase64: String, ivBase64: String, payloadBase64: String, promise: Promise) {
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
            promise.resolve(String(decryptedBytes, Charsets.UTF_8))
        } catch (e: Exception) {
            promise.reject("AES_GCM_DECRYPT_ERR", e.message, e)
        }
    }
}
