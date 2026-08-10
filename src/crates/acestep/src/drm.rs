//! # ⚠️ DEPRECATED — v1.3.0 DRM (ECIES + X25519 + AES-GCM)
//!
//! **This module is DEPRECATED as of v5.** It is preserved only for
//! backward-compatibility decryption of legacy `.a00m` v1.3.0 containers
//! produced by earlier releases. New code MUST use the simplified
//! [`crate::flac_container`] + [`crate::passwords`] pipeline instead
//! (hardcoded multi-version AES-256 ZIP passwords, no asymmetric crypto,
//! no server DRM JWT).
//!
//! Do NOT extend this module with new features. When v1.3.0 compat is
//! eventually dropped, both this file and [`crate::package_container`]
//! will be deleted together.
//!
//! ---
//!
//! DRM cryptographic primitives for `.a00m` v1.3.0 containers.
//!
//! This module provides the Elliptic Curve Integrated Encryption Scheme
//! (ECIES) used to wrap the per-file Media Encryption Key (MEK). The MEK
//! itself encrypts the ZIP payload via AES-256-GCM (handled by
//! [`crate::package_container`]).
//!
//! ## ECIES construction
//!
//! ```text
//! Sender (packaging)                   Recipient (player)
//! ─────────────────                    ──────────────────
//! 1. Generate ephemeral X25519 keypair
//! 2. ECDH(ephemeral_priv, app_pubkey)  → shared_secret
//! 3. HKDF-SHA256(shared_secret,        3. HKDF-SHA256(shared_secret,
//!        salt=pubkey_hash,                    salt=pubkey_hash,
//!        info=MEK_WRAP_INFO, len=32)          info=MEK_WRAP_INFO, len=32)
//!                                    → kek                                 → kek
//! 4. AES-256-GCM(kek, wrap_nonce,     4. AES-256-GCM(kek, wrap_nonce,
//!        AAD, MEK) → wrapped_mek              AAD, wrapped_mek) → MEK
//! 5. Output: ephemeral_pubkey +        5. Inputs: ephemeral_pubkey +
//!    wrap_nonce + wrapped_mek               wrap_nonce + wrapped_mek +
//!                                            app_privkey
//! ```
//!
//! ## Security model
//!
//! - **Non-asymmetric confidentiality**: Even if the player binary is fully
//!   reverse-engineered, the App private key is NOT embedded — it is
//!   delivered only via a short-lived DRM JWT bound to the device's machine
//!   ID. Without a valid JWT, ECIES cannot be reversed.
//! - **Per-file freshness**: A new ephemeral X25519 keypair is generated
//!   for every archive, so identical plaintexts produce different
//!   ciphertexts.
//! - **AAD binding**: The caller-supplied AAD (header bytes) is
//!   authenticated by AES-GCM, preventing header tampering.
//! - **Zeroization**: All secret material (MEK, ephemeral private key,
//!   shared secret, KEK) is wrapped in [`Zeroizing`] and cleared on drop.
//!
//! ## Key versioning
//!
//! The App keypair is versioned server-side. Each file header stores
//! `pubkey_hash` (SHA-256 of the App public key) so the player can look up
//! the matching `wrapped_app_privkey` in its DRM JWT cache.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{bail, Result};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

use crate::package::PackageError;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/// Length of the X25519 public key (bytes).
pub const X25519_PUBKEY_LEN: usize = 32;

/// Length of the Media Encryption Key (bytes). AES-256 requires a 32-byte key.
pub const MEK_LEN: usize = 32;

/// Length of the AES-256-GCM nonce (bytes).
pub const AES_GCM_NONCE_LEN: usize = 12;

/// Length of the AES-256-GCM authentication tag (bytes).
pub const AES_GCM_TAG_LEN: usize = 16;

/// Length of the wrapped MEK: ciphertext (same length as plaintext MEK) + tag.
pub const WRAPPED_MEK_LEN: usize = MEK_LEN + AES_GCM_TAG_LEN;

/// HKDF-SHA256 info string for deriving the MEK wrap key (KEK).
///
/// Bound to the v1.3.0 container format — changing this string would break
/// decryption of all existing DRM files.
pub const MEK_WRAP_INFO: &[u8] = b"a00m-v1.3-mek-wrap";

/// HKDF-SHA256 info string for deriving the machine-bound key that wraps
/// the App private key inside the DRM JWT.
pub const PRIVKEY_UNWRAP_INFO: &[u8] = b"a00m-privkey-unwrap";

/// Length of the derived key (KEK / machine KEK) — always 32 bytes for AES-256.
pub const DERIVED_KEY_LEN: usize = 32;

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/// Output of [`wrap_mek`] — the three components needed by the recipient
/// to reverse the operation via [`unwrap_mek`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedMek {
    /// Ephemeral X25519 public key (32 bytes).
    pub ephemeral_pubkey: [u8; X25519_PUBKEY_LEN],
    /// AES-256-GCM nonce used for the wrap (12 bytes).
    pub wrap_nonce: [u8; AES_GCM_NONCE_LEN],
    /// Wrapped MEK: 32-byte ciphertext + 16-byte GCM tag (48 bytes total).
    pub wrapped_mek: [u8; WRAPPED_MEK_LEN],
}

/// Output of [`wrap_app_privkey`] — the machine-bound wrapped private key
/// carried inside the DRM JWT.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedAppPrivKey {
    /// AES-256-GCM nonce used for the wrap (12 bytes).
    pub wrap_nonce: [u8; AES_GCM_NONCE_LEN],
    /// Wrapped private key: ciphertext + 16-byte GCM tag.
    pub wrapped_privkey: Vec<u8>,
}

// ----------------------------------------------------------------------------
// Public API: MEK wrap / unwrap
// ----------------------------------------------------------------------------

/// Generate a random 32-byte Media Encryption Key.
///
/// Uses `OsRng` (OS CSPRNG) — suitable for cryptographic key generation.
/// The returned key is wrapped in [`Zeroizing`] so it is cleared from
/// memory when dropped.
pub fn generate_mek() -> Zeroizing<[u8; MEK_LEN]> {
    let mut mek = Zeroizing::new([0u8; MEK_LEN]);
    rand::rngs::OsRng.fill_bytes(mek.as_mut_slice());
    mek
}

/// Compute the SHA-256 hash of an App public key.
///
/// Returns a 32-byte array used as:
/// - The HKDF salt when deriving the KEK (so the KEK is bound to the
///   specific key version).
/// - The `pubkey_hash` header field that lets the player select the
///   matching `wrapped_app_privkey` from the DRM JWT cache.
pub fn compute_pubkey_hash(pubkey: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(pubkey);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Wrap a Media Encryption Key with an App public key via ECIES.
///
/// Generates a fresh ephemeral X25519 keypair, performs ECDH with
/// `app_pubkey`, derives a 32-byte KEK via HKDF-SHA256, and encrypts the
/// MEK with AES-256-GCM using the caller-supplied `aad`.
///
/// # Arguments
///
/// * `mek` - 32-byte Media Encryption Key to wrap.
/// * `app_pubkey` - 32-byte X25519 App public key (recipient).
/// * `aad` - Additional authenticated data (header bytes) — authenticated
///   but not encrypted. The same `aad` must be supplied to [`unwrap_mek`].
///
/// # Errors
///
/// Returns an error if `app_pubkey` is not 32 bytes or AES-GCM encryption
/// fails (extremely unlikely with valid inputs).
pub fn wrap_mek(mek: &[u8], app_pubkey: &[u8], aad: &[u8]) -> Result<WrappedMek> {
    if mek.len() != MEK_LEN {
        bail!("invalid MEK length: {} (expected {})", mek.len(), MEK_LEN);
    }
    if app_pubkey.len() != X25519_PUBKEY_LEN {
        bail!(
            "invalid app public key length: {} (expected {})",
            app_pubkey.len(),
            X25519_PUBKEY_LEN
        );
    }

    // 1. Parse the recipient public key.
    let mut pubkey_bytes = [0u8; X25519_PUBKEY_LEN];
    pubkey_bytes.copy_from_slice(app_pubkey);
    let recipient_pubkey = PublicKey::from(pubkey_bytes);

    // 2. Generate an ephemeral keypair. `EphemeralSecret` auto-zeroizes on
    //    drop, so the private half never persists beyond this function.
    let ephemeral_secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
    // Derive the ephemeral public key from the secret (this is NOT the ECDH
    // shared secret — `PublicKey::from(&secret)` performs the X25519 base
    // point multiplication to produce the public counterpart).
    let ephemeral_pubkey = PublicKey::from(&ephemeral_secret);

    // 3. ECDH shared secret: ephemeral_priv * recipient_pubkey.
    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_pubkey);

    // 4. Derive the KEK via HKDF-SHA256. Salt = pubkey_hash, info = MEK_WRAP_INFO.
    let pubkey_hash = compute_pubkey_hash(app_pubkey);
    let kek = derive_kek(shared_secret.as_bytes(), &pubkey_hash, MEK_WRAP_INFO)?;

    // 5. Generate a random wrap nonce.
    let mut wrap_nonce = [0u8; AES_GCM_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut wrap_nonce);

    // 6. AES-256-GCM encrypt the MEK with AAD.
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    let combined = cipher
        .encrypt(Nonce::from_slice(&wrap_nonce), Payload { msg: mek, aad })
        .map_err(|e| anyhow::anyhow!("AES-256-GCM MEK wrap failed: {e}"))?;

    if combined.len() != WRAPPED_MEK_LEN {
        bail!(
            "unexpected wrapped MEK length: {} (expected {})",
            combined.len(),
            WRAPPED_MEK_LEN
        );
    }

    let mut wrapped_mek = [0u8; WRAPPED_MEK_LEN];
    wrapped_mek.copy_from_slice(&combined);

    // Extract ephemeral pubkey bytes for the output.
    let mut ephemeral_pubkey_bytes = [0u8; X25519_PUBKEY_LEN];
    ephemeral_pubkey_bytes.copy_from_slice(ephemeral_pubkey.as_bytes());

    // Note: `ephemeral_secret` and `kek` are zeroized on drop (EphemeralSecret
    // auto-zeroizes; kek is a plain array — we explicitly zero it).
    let mut kek_arr = kek;
    kek_arr.zeroize();

    Ok(WrappedMek {
        ephemeral_pubkey: ephemeral_pubkey_bytes,
        wrap_nonce,
        wrapped_mek,
    })
}

/// Unwrap a Media Encryption Key using the App private key.
///
/// Mirrors [`wrap_mek`]: performs ECDH with `ephemeral_pubkey`, derives the
/// same KEK via HKDF-SHA256, and decrypts the wrapped MEK with AES-256-GCM.
///
/// # Arguments
///
/// * `wrapped` - The [`WrappedMek`] produced by [`wrap_mek`].
/// * `app_privkey` - 32-byte X25519 App private key (recipient's static
///   secret). MUST correspond to the public key used during wrapping.
/// * `app_pubkey` - 32-byte X25519 App public key — used to compute the
///   HKDF salt (must match the pubkey used at wrap time).
/// * `aad` - Additional authenticated data — MUST match the `aad` supplied
///   to [`wrap_mek`]. Any mismatch causes GCM authentication failure.
///
/// # Errors
///
/// Returns [`PackageError::DecryptionFailed`] on:
/// - Wrong App private key (ECDH produces a different shared secret)
/// - AAD tampering (GCM tag verification fails)
/// - Corrupted `wrapped_mek`
pub fn unwrap_mek(
    wrapped: &WrappedMek,
    app_privkey: &[u8],
    app_pubkey: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<[u8; MEK_LEN]>> {
    if app_privkey.len() != X25519_PUBKEY_LEN {
        bail!(
            "invalid app private key length: {} (expected {})",
            app_privkey.len(),
            X25519_PUBKEY_LEN
        );
    }
    if app_pubkey.len() != X25519_PUBKEY_LEN {
        bail!(
            "invalid app public key length: {} (expected {})",
            app_pubkey.len(),
            X25519_PUBKEY_LEN
        );
    }

    // 1. Reconstruct the static secret. Wrap in Zeroizing so it is cleared
    //    on drop. `StaticSecret` also implements ZeroizeOnDrop internally.
    let mut privkey_bytes = Zeroizing::new([0u8; X25519_PUBKEY_LEN]);
    privkey_bytes.copy_from_slice(app_privkey);
    let app_secret = StaticSecret::from(*privkey_bytes);

    // 2. Parse the ephemeral public key from the wrapped blob.
    let mut ephemeral_pubkey_bytes = [0u8; X25519_PUBKEY_LEN];
    ephemeral_pubkey_bytes.copy_from_slice(&wrapped.ephemeral_pubkey);
    let ephemeral_pubkey = PublicKey::from(ephemeral_pubkey_bytes);

    // 3. ECDH: shared_secret = app_privkey * ephemeral_pubkey
    let shared_secret = app_secret.diffie_hellman(&ephemeral_pubkey);

    // 4. Derive the KEK with the same parameters as wrap_mek.
    let pubkey_hash = compute_pubkey_hash(app_pubkey);
    let kek = derive_kek(shared_secret.as_bytes(), &pubkey_hash, MEK_WRAP_INFO)?;

    // 5. AES-256-GCM decrypt with AAD verification.
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&wrapped.wrap_nonce),
            Payload {
                msg: &wrapped.wrapped_mek,
                aad,
            },
        )
        .map_err(|_| {
            PackageError::DecryptionFailed(
                "MEK unwrap failed: wrong app private key, AAD mismatch, or corrupted wrapped_mek"
                    .into(),
            )
        })?;

    if plaintext.len() != MEK_LEN {
        bail!(
            "unexpected unwrapped MEK length: {} (expected {})",
            plaintext.len(),
            MEK_LEN
        );
    }

    let mut mek = Zeroizing::new([0u8; MEK_LEN]);
    mek.copy_from_slice(&plaintext);

    // Explicit zeroization of derived material (defense in depth —
    // StaticSecret and Zeroizing already handle their own cleanup).
    let mut kek_arr = kek;
    kek_arr.zeroize();

    Ok(mek)
}

// ----------------------------------------------------------------------------
// Public API: App private key wrap / unwrap (machine binding)
// ----------------------------------------------------------------------------

/// Wrap an App X25519 private key with a machine-bound KEK.
///
/// Used by the Ai00-Salvo server when issuing a DRM JWT: the App private
/// key for a given version is encrypted with a KEK derived from the
/// device's `machine_id` via HKDF-SHA256. This ensures the JWT is useless
/// if exfiltrated to a different machine.
///
/// # Arguments
///
/// * `app_privkey` - 32-byte X25519 App private key to wrap.
/// * `machine_id` - Device fingerprint (e.g. SHA-256 hex of hardware IDs).
/// * `server_salt` - Server-side salt (32 bytes recommended) — prevents
///   offline KEK derivation even if the machine_id algorithm is known.
/// * `aad` - Additional authenticated data. SHOULD be the machine_id bytes
///   to bind the wrapped key to this specific device.
pub fn wrap_app_privkey(
    app_privkey: &[u8],
    machine_id: &[u8],
    server_salt: &[u8],
    aad: &[u8],
) -> Result<WrappedAppPrivKey> {
    if app_privkey.len() != X25519_PUBKEY_LEN {
        bail!(
            "invalid app private key length: {} (expected {})",
            app_privkey.len(),
            X25519_PUBKEY_LEN
        );
    }

    // Derive machine KEK: HKDF(machine_id, salt=server_salt, info=PRIVKEY_UNWRAP_INFO)
    let machine_kek = derive_machine_kek(machine_id, server_salt)?;

    // Random nonce.
    let mut wrap_nonce = [0u8; AES_GCM_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut wrap_nonce);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&machine_kek));
    let combined = cipher
        .encrypt(
            Nonce::from_slice(&wrap_nonce),
            Payload {
                msg: app_privkey,
                aad,
            },
        )
        .map_err(|e| anyhow::anyhow!("AES-256-GCM privkey wrap failed: {e}"))?;

    let mut kek_arr = machine_kek;
    kek_arr.zeroize();

    Ok(WrappedAppPrivKey {
        wrap_nonce,
        wrapped_privkey: combined,
    })
}

/// Unwrap an App X25519 private key using the machine-bound KEK.
///
/// Mirrors [`wrap_app_privkey`]. The caller must supply the same
/// `machine_id`, `server_salt`, and `aad` used during wrapping.
///
/// # Errors
///
/// Returns [`PackageError::DecryptionFailed`] on wrong machine_id, AAD
/// mismatch, or corrupted wrapped_privkey.
pub fn unwrap_app_privkey(
    wrapped: &WrappedAppPrivKey,
    machine_id: &[u8],
    server_salt: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<[u8; X25519_PUBKEY_LEN]>> {
    let machine_kek = derive_machine_kek(machine_id, server_salt)?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&machine_kek));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&wrapped.wrap_nonce),
            Payload {
                msg: &wrapped.wrapped_privkey,
                aad,
            },
        )
        .map_err(|_| {
            PackageError::DecryptionFailed(
                "App privkey unwrap failed: wrong machine_id, AAD mismatch, or corrupted wrapped_privkey"
                    .into(),
            )
        })?;

    if plaintext.len() != X25519_PUBKEY_LEN {
        bail!(
            "unexpected unwrapped privkey length: {} (expected {})",
            plaintext.len(),
            X25519_PUBKEY_LEN
        );
    }

    let mut privkey = Zeroizing::new([0u8; X25519_PUBKEY_LEN]);
    privkey.copy_from_slice(&plaintext);

    let mut kek_arr = machine_kek;
    kek_arr.zeroize();

    Ok(privkey)
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/// Derive a 32-byte key via HKDF-SHA256.
///
/// # Arguments
///
/// * `ikm` - Input keying material (e.g. ECDH shared secret).
/// * `salt` - HKDF salt (e.g. pubkey_hash). May be empty, but a non-empty
///   salt is strongly recommended for domain separation.
/// * `info` - Context/application-specific info string (domain separation).
fn derive_kek(ikm: &[u8], salt: &[u8], info: &[u8]) -> Result<[u8; DERIVED_KEY_LEN]> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = [0u8; DERIVED_KEY_LEN];
    hk.expand(info, &mut okm)
        .map_err(|e| anyhow::anyhow!("HKDF-SHA256 expand failed: {e}"))?;
    Ok(okm)
}

/// Derive the machine-bound KEK used for wrapping the App private key.
///
/// `machine_id` is the IKM, `server_salt` is the HKDF salt, and
/// [`PRIVKEY_UNWRAP_INFO`] is the info string. This produces a 32-byte
/// AES-256 key that is unique per (machine_id, server_salt) pair.
fn derive_machine_kek(machine_id: &[u8], server_salt: &[u8]) -> Result<[u8; DERIVED_KEY_LEN]> {
    derive_kek(machine_id, server_salt, PRIVKEY_UNWRAP_INFO)
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)] // tests may use unwrap for convenience

    use super::*;
    use x25519_dalek::StaticSecret;

    /// Generate a random X25519 keypair for testing.
    fn gen_keypair() -> (StaticSecret, PublicKey) {
        let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let pubkey = PublicKey::from(&secret);
        (secret, pubkey)
    }

    #[test]
    fn mek_wrap_unwrap_round_trip() {
        let (app_secret, app_pubkey) = gen_keypair();
        let app_privkey_bytes = app_secret.to_bytes();
        let app_pubkey_bytes = app_pubkey.to_bytes();

        let mek = generate_mek();
        let aad = b"test header aad bytes";

        let wrapped = wrap_mek(mek.as_slice(), &app_pubkey_bytes, aad).unwrap();
        let unwrapped = unwrap_mek(&wrapped, &app_privkey_bytes, &app_pubkey_bytes, aad).unwrap();

        assert_eq!(mek.as_slice(), unwrapped.as_slice());
    }

    #[test]
    fn mek_unwrap_wrong_privkey_fails() {
        let (_, app_pubkey) = gen_keypair();
        let (other_secret, _) = gen_keypair();

        let mek = generate_mek();
        let aad = b"test aad";

        let wrapped = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), aad).unwrap();
        let result = unwrap_mek(
            &wrapped,
            &other_secret.to_bytes(),
            &app_pubkey.to_bytes(),
            aad,
        );

        assert!(matches!(
            result,
            Err(e) if e.downcast_ref::<PackageError>()
                .is_some_and(|pe| matches!(pe, PackageError::DecryptionFailed(_)))
        ));
    }

    #[test]
    fn mek_unwrap_aad_tamper_fails() {
        let (app_secret, app_pubkey) = gen_keypair();

        let mek = generate_mek();
        let aad = b"original aad";

        let wrapped = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), aad).unwrap();

        // Flip a bit in the AAD.
        let tampered_aad = b"tampered aad";
        let result = unwrap_mek(
            &wrapped,
            &app_secret.to_bytes(),
            &app_pubkey.to_bytes(),
            tampered_aad,
        );

        assert!(matches!(
            result,
            Err(e) if e.downcast_ref::<PackageError>()
                .is_some_and(|pe| matches!(pe, PackageError::DecryptionFailed(_)))
        ));
    }

    #[test]
    fn mek_unwrap_wrong_pubkey_fails() {
        let (app_secret, app_pubkey) = gen_keypair();
        let (_, other_pubkey) = gen_keypair();

        let mek = generate_mek();
        let aad = b"aad";

        // Wrap with app_pubkey but try to unwrap using other_pubkey for the
        // salt derivation — KEK will differ.
        let wrapped = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), aad).unwrap();
        let result = unwrap_mek(
            &wrapped,
            &app_secret.to_bytes(),
            &other_pubkey.to_bytes(),
            aad,
        );

        assert!(result.is_err());
    }

    #[test]
    fn wrapped_mek_length_is_fixed() {
        let (_, app_pubkey) = gen_keypair();
        let mek = generate_mek();

        let wrapped = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), b"aad").unwrap();

        assert_eq!(wrapped.ephemeral_pubkey.len(), X25519_PUBKEY_LEN);
        assert_eq!(wrapped.wrap_nonce.len(), AES_GCM_NONCE_LEN);
        assert_eq!(wrapped.wrapped_mek.len(), WRAPPED_MEK_LEN);
        assert_eq!(WRAPPED_MEK_LEN, MEK_LEN + AES_GCM_TAG_LEN);
    }

    #[test]
    fn wrap_mek_rejects_invalid_pubkey_length() {
        let mek = generate_mek();
        let bad_pubkey = [0u8; 31]; // wrong length

        let result = wrap_mek(mek.as_slice(), &bad_pubkey, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn wrap_mek_rejects_invalid_mek_length() {
        let (_, app_pubkey) = gen_keypair();
        let bad_mek = [0u8; 16]; // wrong length

        let result = wrap_mek(&bad_mek, &app_pubkey.to_bytes(), b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn wrap_mek_produces_different_ephemeral_keys() {
        // Each wrap_mek call generates a fresh ephemeral keypair, so two
        // wraps of the same MEK must produce different ephemeral pubkeys.
        let (_, app_pubkey) = gen_keypair();
        let mek = generate_mek();

        let w1 = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), b"aad").unwrap();
        let w2 = wrap_mek(mek.as_slice(), &app_pubkey.to_bytes(), b"aad").unwrap();

        assert_ne!(w1.ephemeral_pubkey, w2.ephemeral_pubkey);
        assert_ne!(w1.wrap_nonce, w2.wrap_nonce);
        assert_ne!(w1.wrapped_mek, w2.wrapped_mek);
    }

    #[test]
    fn app_privkey_wrap_unwrap_round_trip() {
        let (app_secret, _) = gen_keypair();
        let app_privkey = app_secret.to_bytes();

        let machine_id = b"abc123def4567890abcdef0123456789";
        let server_salt = b"server-salt-32-bytes-long-aaaaa";
        let aad = machine_id; // bind to machine

        let wrapped = wrap_app_privkey(&app_privkey, machine_id, server_salt, aad).unwrap();
        let unwrapped = unwrap_app_privkey(&wrapped, machine_id, server_salt, aad).unwrap();

        assert_eq!(app_privkey.as_slice(), unwrapped.as_slice());
    }

    #[test]
    fn app_privkey_unwrap_wrong_machine_fails() {
        let (app_secret, _) = gen_keypair();
        let app_privkey = app_secret.to_bytes();

        let machine_id = b"machine-A";
        let other_machine = b"machine-B";
        let server_salt = b"server-salt";
        let aad = machine_id;

        let wrapped = wrap_app_privkey(&app_privkey, machine_id, server_salt, aad).unwrap();
        let result = unwrap_app_privkey(&wrapped, other_machine, server_salt, aad);

        assert!(matches!(
            result,
            Err(e) if e.downcast_ref::<PackageError>()
                .is_some_and(|pe| matches!(pe, PackageError::DecryptionFailed(_)))
        ));
    }

    #[test]
    fn app_privkey_unwrap_wrong_salt_fails() {
        let (app_secret, _) = gen_keypair();
        let app_privkey = app_secret.to_bytes();

        let machine_id = b"machine-A";
        let salt1 = b"salt-1";
        let salt2 = b"salt-2";
        let aad = machine_id;

        let wrapped = wrap_app_privkey(&app_privkey, machine_id, salt1, aad).unwrap();
        let result = unwrap_app_privkey(&wrapped, machine_id, salt2, aad);

        assert!(result.is_err());
    }

    #[test]
    fn app_privkey_unwrap_aad_tamper_fails() {
        let (app_secret, _) = gen_keypair();
        let app_privkey = app_secret.to_bytes();

        let machine_id = b"machine-A";
        let server_salt = b"server-salt";
        let aad = b"original aad";

        let wrapped = wrap_app_privkey(&app_privkey, machine_id, server_salt, aad).unwrap();
        let result = unwrap_app_privkey(&wrapped, machine_id, server_salt, b"tampered aad");

        assert!(result.is_err());
    }

    #[test]
    fn pubkey_hash_is_deterministic() {
        let (_, pubkey) = gen_keypair();
        let pubkey_bytes = pubkey.to_bytes();

        let h1 = compute_pubkey_hash(&pubkey_bytes);
        let h2 = compute_pubkey_hash(&pubkey_bytes);

        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 32);
    }

    #[test]
    fn pubkey_hash_differs_for_different_keys() {
        let (_, p1) = gen_keypair();
        let (_, p2) = gen_keypair();

        let h1 = compute_pubkey_hash(&p1.to_bytes());
        let h2 = compute_pubkey_hash(&p2.to_bytes());

        assert_ne!(h1, h2);
    }

    #[test]
    fn generate_mek_is_random() {
        let m1 = generate_mek();
        let m2 = generate_mek();
        assert_ne!(m1.as_slice(), m2.as_slice());
    }

    #[test]
    fn full_ecies_round_trip_with_machine_wrapped_privkey() {
        // End-to-end: simulate the full DRM decrypt flow.
        // 1. Server has an App keypair.
        // 2. Server wraps App privkey with machine KEK (delivered via JWT).
        // 3. Client unwraps App privkey.
        // 4. Client unwraps MEK using App privkey.
        // 5. (Payload decryption is tested in package_container.rs.)

        let (app_secret, app_pubkey) = gen_keypair();
        let app_privkey = app_secret.to_bytes();
        let app_pubkey_bytes = app_pubkey.to_bytes();

        // Server-side: wrap privkey for this machine.
        let machine_id = b"machine-abc-123";
        let server_salt = b"server-salt-32-bytes-aaaaaaaaa";
        let machine_aad = machine_id;
        let wrapped_privkey =
            wrap_app_privkey(&app_privkey, machine_id, server_salt, machine_aad).unwrap();

        // Client-side: unwrap privkey.
        let recovered_privkey =
            unwrap_app_privkey(&wrapped_privkey, machine_id, server_salt, machine_aad).unwrap();
        assert_eq!(recovered_privkey.as_slice(), app_privkey);

        // Packager-side: wrap MEK with App pubkey.
        let mek = generate_mek();
        let header_aad = b"header bytes 0..96";
        let wrapped_mek = wrap_mek(mek.as_slice(), &app_pubkey_bytes, header_aad).unwrap();

        // Client-side: unwrap MEK using recovered privkey.
        let recovered_mek = unwrap_mek(
            &wrapped_mek,
            recovered_privkey.as_slice(),
            &app_pubkey_bytes,
            header_aad,
        )
        .unwrap();

        assert_eq!(recovered_mek.as_slice(), mek.as_slice());
    }
}
