//! # ⚠️ DEPRECATED — v1.2.0 / v1.3.0 encrypted container format
//!
//! **This module is DEPRECATED as of v5.** It is preserved only for
//! backward-compatibility decryption of legacy `.a00m` v1.2.0 / v1.3.0
//! containers produced by earlier releases. New code MUST use the
//! simplified [`crate::flac_container`] + [`crate::passwords`] pipeline
//! instead (standard FLAC + APPLICATION block with AES-256 ZIP encryption
//! using hardcoded multi-version passwords).
//!
//! Per the v5 plan, v1.2.0 containers are now explicitly rejected at
//! decrypt time (see `decrypt_container_auto`). Only v1.3.0 ECIES
//! containers can still be decrypted for migration purposes.
//!
//! Do NOT extend this module with new features. When backward-compat is
//! eventually dropped, both this file and [`crate::drm`] will be deleted
//! together.
//!
//! ---
//!
//! Encrypted container format for `.a00m` v1.2.0+ archives.
//!
//! When the user provides a password at packaging time, the archive is NOT a
//! standard ZIP. Instead it uses a custom binary container that wraps an
//! AES-256-GCM-encrypted standard ZIP:
//!
//! ```text
//! Offset  Length  Field
//! 0       4       magic               "A00M" (0x41 0x30 0x30 0x4D)
//! 4       1       container_version   0x12 (= v1.2.0)
//! 5       1       kdf_algorithm       0x01 (= argon2id)
//! 6       1       cipher_algorithm    0x01 (= aes-256-gcm)
//! 7       16      kdf_salt            Argon2id salt (random)
//! 23      4       kdf_iterations      u32 LE
//! 27      4       kdf_memory_kib      u32 LE
//! 31      4       kdf_parallelism     u32 LE
//! 35      12      nonce               AES-GCM nonce (random)
//! 47      8       payload_length      u64 LE (ciphertext length = plaintext ZIP length)
//! 55      N       ciphertext          AES-256-GCM ciphertext (same length as plaintext ZIP)
//! 55+N    16      gcm_tag             GCM authentication tag
//! ```
//!
//! ## Security model
//!
//! - **Key derivation**: Argon2id (memory-hard) — 64 MiB / 3 iterations / 4 lanes.
//!   GPU parallelism is throttled by the memory cost, resisting hashcat-style
//!   brute force.
//! - **Encryption**: AES-256-GCM (authenticated encryption). The GCM tag
//!   detects any tampering with ciphertext or header.
//! - **Format obscurity**: The `A00M` magic makes the file unrecognizable to
//!   standard tools (7-Zip, WinZip, hashcat), so no off-the-shelf cracking
//!   pipeline applies. This is defense-in-depth, NOT the primary security
//!   mechanism — Kerckhoffs's principle holds: security rests on the password
//!   + Argon2id + AES-256-GCM, not on format secrecy.
//!
//! ## Backward compatibility
//!
//! v1.0.0 / v1.1.0 archives (and v1.2.0 archives packaged without a password)
//! remain standard ZIP files with magic `PK\x03\x04`. Readers detect the magic
//! and branch accordingly.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;

use crate::package::PackageError;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/// Container magic — `A00M` (0x41 0x30 0x30 0x4D).
pub const MAGIC_A00M: [u8; 4] = *b"A00M";

/// Container version byte. 0x12 = v1.2.0.
pub const CONTAINER_VERSION: u8 = 0x12;

/// KDF algorithm byte. 0x01 = Argon2id.
const KDF_ALGORITHM_ARGON2ID: u8 = 0x01;

/// Cipher algorithm byte. 0x01 = AES-256-GCM.
const CIPHER_ALGORITHM_AES_256_GCM: u8 = 0x01;

/// Fixed header size (bytes) before the ciphertext payload.
pub const HEADER_SIZE: usize = 55;

/// Argon2id parameters — OWASP 2023 recommended minimum.
const KDF_ITERATIONS: u32 = 3;
const KDF_MEMORY_KIB: u32 = 65536; // 64 MiB
const KDF_PARALLELISM: u32 = 4;

/// AES-256 key length (bytes).
const AES_KEY_LEN: usize = 32;
/// AES-GCM nonce length (bytes).
const AES_NONCE_LEN: usize = 12;
/// AES-GCM authentication tag length (bytes).
const AES_TAG_LEN: usize = 16;
/// Argon2id salt length (bytes).
const KDF_SALT_LEN: usize = 16;

// ----------------------------------------------------------------------------
// Header type
// ----------------------------------------------------------------------------

/// Parsed container header. All fields needed to derive the key and decrypt
/// the payload.
#[derive(Debug, Clone)]
pub struct ContainerHeader {
    pub container_version: u8,
    pub kdf_algorithm: u8,
    pub cipher_algorithm: u8,
    pub kdf_salt: [u8; KDF_SALT_LEN],
    pub kdf_iterations: u32,
    pub kdf_memory_kib: u32,
    pub kdf_parallelism: u32,
    pub nonce: [u8; AES_NONCE_LEN],
    pub payload_length: u64,
}

impl ContainerHeader {
    /// Serialize to the 55-byte fixed-layout header.
    pub fn to_bytes(&self) -> [u8; HEADER_SIZE] {
        let mut buf = [0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(&MAGIC_A00M);
        buf[4] = self.container_version;
        buf[5] = self.kdf_algorithm;
        buf[6] = self.cipher_algorithm;
        buf[7..23].copy_from_slice(&self.kdf_salt);
        buf[23..27].copy_from_slice(&self.kdf_iterations.to_le_bytes());
        buf[27..31].copy_from_slice(&self.kdf_memory_kib.to_le_bytes());
        buf[31..35].copy_from_slice(&self.kdf_parallelism.to_le_bytes());
        buf[35..47].copy_from_slice(&self.nonce);
        buf[47..55].copy_from_slice(&self.payload_length.to_le_bytes());
        buf
    }

    /// Parse from a 55-byte buffer.
    pub fn from_bytes(buf: &[u8; HEADER_SIZE]) -> Result<Self> {
        if buf[0..4] != MAGIC_A00M {
            bail!("invalid magic: expected A00M, got {:?}", &buf[0..4]);
        }
        let container_version = buf[4];
        let kdf_algorithm = buf[5];
        let cipher_algorithm = buf[6];

        if kdf_algorithm != KDF_ALGORITHM_ARGON2ID {
            bail!("unsupported KDF algorithm byte: 0x{kdf_algorithm:02x}");
        }
        if cipher_algorithm != CIPHER_ALGORITHM_AES_256_GCM {
            bail!("unsupported cipher algorithm byte: 0x{cipher_algorithm:02x}");
        }

        let mut kdf_salt = [0u8; KDF_SALT_LEN];
        kdf_salt.copy_from_slice(&buf[7..23]);

        let kdf_iterations = u32::from_le_bytes(buf[23..27].try_into().expect("slice len"));
        let kdf_memory_kib = u32::from_le_bytes(buf[27..31].try_into().expect("slice len"));
        let kdf_parallelism = u32::from_le_bytes(buf[31..35].try_into().expect("slice len"));

        let mut nonce = [0u8; AES_NONCE_LEN];
        nonce.copy_from_slice(&buf[35..47]);

        let payload_length = u64::from_le_bytes(buf[47..55].try_into().expect("slice len"));

        Ok(Self {
            container_version,
            kdf_algorithm,
            cipher_algorithm,
            kdf_salt,
            kdf_iterations,
            kdf_memory_kib,
            kdf_parallelism,
            nonce,
            payload_length,
        })
    }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/// Check whether the file at `path` starts with the `A00M` magic, i.e. is an
/// encrypted v1.2.0+ container (as opposed to a standard ZIP archive).
///
/// Returns `false` for any non-existent file or read error — callers should
/// treat `false` as "not an encrypted container, try standard ZIP".
pub fn is_encrypted_container(path: &Path) -> bool {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    magic == MAGIC_A00M
}

/// Encrypt `zip_bytes` with a key derived from `password` and write the
/// resulting container to `output_path`.
///
/// Generates fresh random salt + nonce per archive. The Argon2id parameters
/// are the OWASP-recommended minimum (64 MiB / 3 iterations / 4 lanes) and
/// are embedded in the header so future readers can re-derive the key.
pub fn write_encrypted_container(
    output_path: &Path,
    zip_bytes: &[u8],
    password: &str,
) -> Result<()> {
    // 1. Generate random salt + nonce.
    let mut rng = rand::rngs::OsRng;
    let mut kdf_salt = [0u8; KDF_SALT_LEN];
    let mut nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut kdf_salt);
    rng.fill_bytes(&mut nonce);

    // 2. Derive AES-256 key from password via Argon2id.
    let key = derive_key(
        password,
        &kdf_salt,
        KDF_ITERATIONS,
        KDF_MEMORY_KIB,
        KDF_PARALLELISM,
    )
    .context("Argon2id key derivation failed")?;

    // 3. AES-256-GCM encrypt. The `aes-gcm` crate appends the 16-byte tag to
    //    the ciphertext, so the output is `ciphertext || tag`.
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let combined = cipher
        .encrypt(Nonce::from_slice(&nonce), zip_bytes)
        .map_err(|e| anyhow::anyhow!("AES-256-GCM encryption failed: {e}"))?;

    // Split ciphertext and tag for the container layout.
    let ct_len = combined.len() - AES_TAG_LEN;
    let ciphertext = &combined[..ct_len];
    let tag = &combined[ct_len..];

    // 4. Build header.
    let header = ContainerHeader {
        container_version: CONTAINER_VERSION,
        kdf_algorithm: KDF_ALGORITHM_ARGON2ID,
        cipher_algorithm: CIPHER_ALGORITHM_AES_256_GCM,
        kdf_salt,
        kdf_iterations: KDF_ITERATIONS,
        kdf_memory_kib: KDF_MEMORY_KIB,
        kdf_parallelism: KDF_PARALLELISM,
        nonce,
        payload_length: ciphertext.len() as u64,
    };

    // 5. Write container: header + ciphertext + tag.
    let mut file = File::create(output_path)
        .with_context(|| format!("failed to create container file: {}", output_path.display()))?;
    file.write_all(&header.to_bytes())
        .context("failed to write container header")?;
    file.write_all(ciphertext)
        .context("failed to write ciphertext")?;
    file.write_all(tag).context("failed to write GCM tag")?;
    file.sync_all().context("failed to sync container file")?;

    log::info!(
        "Wrote encrypted .a00m container: {} ({} bytes plaintext → {} bytes ciphertext)",
        output_path.display(),
        zip_bytes.len(),
        ciphertext.len()
    );

    Ok(())
}

/// Read and parse the container header from `path`. Does NOT decrypt.
pub fn read_container_header(path: &Path) -> Result<ContainerHeader> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open: {}", path.display()))?;
    let mut buf = [0u8; HEADER_SIZE];
    file.read_exact(&mut buf)
        .context("failed to read container header (file too short?)")?;
    ContainerHeader::from_bytes(&buf).context("invalid container header")
}

/// Decrypt the container at `path` using `password`, returning the plaintext
/// ZIP bytes.
///
/// Verifies the GCM tag — returns `PackageError::DecryptionFailed` on wrong
/// password or any tampering.
pub fn decrypt_container(path: &Path, password: &str) -> Result<Vec<u8>> {
    let header = read_container_header(path)?;
    let payload_length = header.payload_length as usize;

    let mut file =
        File::open(path).with_context(|| format!("failed to open: {}", path.display()))?;
    // Skip the 55-byte header.
    file.read_exact(&mut [0u8; HEADER_SIZE])
        .context("failed to skip header")?;

    let mut ciphertext = vec![0u8; payload_length];
    file.read_exact(&mut ciphertext)
        .context("failed to read ciphertext")?;

    let mut tag = [0u8; AES_TAG_LEN];
    file.read_exact(&mut tag)
        .context("failed to read GCM tag")?;

    // Re-derive the key from the password + stored salt + stored KDF params.
    let key = derive_key(
        password,
        &header.kdf_salt,
        header.kdf_iterations,
        header.kdf_memory_kib,
        header.kdf_parallelism,
    )
    .context("Argon2id key derivation failed")?;

    // Reassemble `ciphertext || tag` for the aes-gcm crate.
    let mut combined = ciphertext;
    combined.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&header.nonce), combined.as_ref())
        .map_err(|_| {
            PackageError::DecryptionFailed("wrong password or corrupted archive".into())
        })?;

    log::info!(
        "Decrypted .a00m container: {} ({} bytes ciphertext → {} bytes plaintext)",
        path.display(),
        payload_length,
        plaintext.len()
    );

    Ok(plaintext)
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/// Derive a 32-byte AES-256 key from `password` + `salt` via Argon2id.
fn derive_key(
    password: &str,
    salt: &[u8; KDF_SALT_LEN],
    iterations: u32,
    memory_kib: u32,
    parallelism: u32,
) -> Result<[u8; AES_KEY_LEN]> {
    let params = Params::new(memory_kib, iterations, parallelism, Some(AES_KEY_LEN))
        .map_err(|e| anyhow::anyhow!("invalid Argon2id params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; AES_KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("Argon2id hash failed: {e}"))?;
    Ok(key)
}

// ============================================================================
// v1.3.0 DRM container format
// ============================================================================
//
// Uses X25519 ECIES to wrap a per-file MEK, which then encrypts the ZIP
// payload. The App private key is delivered out-of-band via a short-lived
// DRM JWT (see desktop `drm` module). This file format only stores the App
// PUBLIC key hash (to select the key version) and the ECIES-wrapped MEK.
//
// ```text
// Offset  Length  Field
// 0       4       magic               "A00M"
// 4       1       container_version   0x13 (= v1.3.0 DRM)
// 5       1       kdf_algorithm       0x02 (= HKDF-SHA256)
// 6       1       cipher_algorithm    0x01 (= AES-256-GCM)
// 7       1       keywrap_algorithm   0x01 (= X25519-ECIES)
// 8       32      pubkey_hash         SHA-256(app_pubkey)
// 40      32      ephemeral_pubkey    X25519 ephemeral public key
// 72      12      wrap_nonce          AES-GCM nonce for MEK wrap
// 84      12      payload_nonce       AES-GCM nonce for payload
// 96      8       wrapped_mek_len     u64 LE (always 48)
// 104     8       payload_length      u64 LE
// 112     32      payload_aad_hash    SHA-256(header[0..112])
// 144     7       reserved            zeros
// 151     48      wrapped_mek         ECIES(MEK, app_pubkey)
// 199     N       payload             AES-256-GCM(MEK, zip_bytes)
// 199+N   16      payload_tag         GCM tag
// ```

/// Container version byte for v1.3.0 DRM containers.
pub const CONTAINER_VERSION_DRM: u8 = 0x13;

/// KDF algorithm byte for HKDF-SHA256 (v1.3.0).
const KDF_ALGORITHM_HKDF_SHA256: u8 = 0x02;

/// Key wrap algorithm byte for X25519-ECIES (v1.3.0).
const KEYWRAP_ALGORITHM_X25519_ECIES: u8 = 0x01;

/// Fixed v1.3.0 header size (bytes), excluding `wrapped_mek`.
pub const DRM_HEADER_SIZE: usize = 151;

/// Length of the App public key hash field (bytes).
const DRM_PUBKEY_HASH_LEN: usize = 32;

/// Length of the ephemeral X25519 public key field (bytes).
const DRM_EPHEMERAL_PUBKEY_LEN: usize = 32;

/// Length of the reserved field (bytes).
const DRM_RESERVED_LEN: usize = 7;

/// AAD for MEK wrap/unwrap: header bytes [0..40) — magic, version, algorithms,
/// and pubkey_hash. Excludes `ephemeral_pubkey` (offset 40..72) because that
/// field is generated INSIDE `wrap_mek` and isn't known until after the ECIES
/// operation. Binding to format version and App key version is sufficient to
/// prevent version downgrade and key substitution attacks.
const DRM_MEK_WRAP_AAD_LEN: usize = 40;

/// AAD for payload encryption: header bytes [0..144).
const DRM_PAYLOAD_AAD_LEN: usize = 144;

/// Hash coverage for `payload_aad_hash`: header bytes [0..112).
const DRM_PAYLOAD_AAD_HASH_COVERAGE: usize = 112;

/// Parsed v1.3.0 DRM container header. All fields needed to locate the
/// wrapped MEK and payload, plus the AAD material for AES-GCM.
#[derive(Debug, Clone)]
pub struct DrmContainerHeader {
    pub container_version: u8,
    pub kdf_algorithm: u8,
    pub cipher_algorithm: u8,
    pub keywrap_algorithm: u8,
    pub pubkey_hash: [u8; DRM_PUBKEY_HASH_LEN],
    pub ephemeral_pubkey: [u8; DRM_EPHEMERAL_PUBKEY_LEN],
    pub wrap_nonce: [u8; AES_NONCE_LEN],
    pub payload_nonce: [u8; AES_NONCE_LEN],
    pub wrapped_mek_len: u64,
    pub payload_length: u64,
    pub payload_aad_hash: [u8; 32],
    pub reserved: [u8; DRM_RESERVED_LEN],
}

impl DrmContainerHeader {
    /// Serialize the fixed 151-byte header (without `wrapped_mek`) to bytes.
    pub fn to_bytes(&self) -> [u8; DRM_HEADER_SIZE] {
        let mut buf = [0u8; DRM_HEADER_SIZE];
        buf[0..4].copy_from_slice(&MAGIC_A00M);
        buf[4] = self.container_version;
        buf[5] = self.kdf_algorithm;
        buf[6] = self.cipher_algorithm;
        buf[7] = self.keywrap_algorithm;
        buf[8..40].copy_from_slice(&self.pubkey_hash);
        buf[40..72].copy_from_slice(&self.ephemeral_pubkey);
        buf[72..84].copy_from_slice(&self.wrap_nonce);
        buf[84..96].copy_from_slice(&self.payload_nonce);
        buf[96..104].copy_from_slice(&self.wrapped_mek_len.to_le_bytes());
        buf[104..112].copy_from_slice(&self.payload_length.to_le_bytes());
        buf[112..144].copy_from_slice(&self.payload_aad_hash);
        buf[144..151].copy_from_slice(&self.reserved);
        buf
    }

    /// Parse a 151-byte buffer into a v1.3.0 header.
    pub fn from_bytes(buf: &[u8; DRM_HEADER_SIZE]) -> Result<Self> {
        if buf[0..4] != MAGIC_A00M {
            bail!("invalid magic: expected A00M, got {:?}", &buf[0..4]);
        }
        let container_version = buf[4];
        if container_version != CONTAINER_VERSION_DRM {
            bail!(
                "container version mismatch: expected 0x{:02x} (DRM), got 0x{:02x}",
                CONTAINER_VERSION_DRM,
                container_version
            );
        }
        let kdf_algorithm = buf[5];
        if kdf_algorithm != KDF_ALGORITHM_HKDF_SHA256 {
            bail!("unsupported KDF algorithm byte: 0x{kdf_algorithm:02x}");
        }
        let cipher_algorithm = buf[6];
        if cipher_algorithm != CIPHER_ALGORITHM_AES_256_GCM {
            bail!("unsupported cipher algorithm byte: 0x{cipher_algorithm:02x}");
        }
        let keywrap_algorithm = buf[7];
        if keywrap_algorithm != KEYWRAP_ALGORITHM_X25519_ECIES {
            bail!("unsupported keywrap algorithm byte: 0x{keywrap_algorithm:02x}");
        }

        let mut pubkey_hash = [0u8; DRM_PUBKEY_HASH_LEN];
        pubkey_hash.copy_from_slice(&buf[8..40]);

        let mut ephemeral_pubkey = [0u8; DRM_EPHEMERAL_PUBKEY_LEN];
        ephemeral_pubkey.copy_from_slice(&buf[40..72]);

        let mut wrap_nonce = [0u8; AES_NONCE_LEN];
        wrap_nonce.copy_from_slice(&buf[72..84]);

        let mut payload_nonce = [0u8; AES_NONCE_LEN];
        payload_nonce.copy_from_slice(&buf[84..96]);

        let wrapped_mek_len = u64::from_le_bytes(buf[96..104].try_into().expect("slice len"));
        let payload_length = u64::from_le_bytes(buf[104..112].try_into().expect("slice len"));

        let mut payload_aad_hash = [0u8; 32];
        payload_aad_hash.copy_from_slice(&buf[112..144]);

        let mut reserved = [0u8; DRM_RESERVED_LEN];
        reserved.copy_from_slice(&buf[144..151]);

        Ok(Self {
            container_version,
            kdf_algorithm,
            cipher_algorithm,
            keywrap_algorithm,
            pubkey_hash,
            ephemeral_pubkey,
            wrap_nonce,
            payload_nonce,
            wrapped_mek_len,
            payload_length,
            payload_aad_hash,
            reserved,
        })
    }
}

/// Decryption context for v1.3.0 DRM containers.
///
/// Holds the already-unwrapped App private key and the matching public key.
/// The desktop `drm` module is responsible for obtaining the private key
/// (from the DRM JWT + machine binding) before calling
/// [`decrypt_drm_container`].
#[derive(Clone)]
pub struct DrmDecryptContext {
    /// 32-byte X25519 App private key (unwrapped from JWT).
    pub app_privkey: [u8; 32],
    /// 32-byte X25519 App public key (used for HKDF salt derivation).
    pub app_pubkey: [u8; 32],
}

/// Write a v1.3.0 DRM container to `output_path`.
///
/// Generates a fresh MEK + ephemeral X25519 keypair, wraps the MEK with
/// `app_pubkey` via ECIES, and encrypts `zip_bytes` with the MEK via
/// AES-256-GCM. All secret material is zeroized after use.
///
/// # Execution order (important — AAD/hash dependencies)
///
/// 1. Fill header fields known before ECIES (magic, version, algos,
///    pubkey_hash, payload_nonce, wrapped_mek_len, payload_length).
///    `ephemeral_pubkey` and `wrap_nonce` are NOT filled here — they are
///    produced inside `wrap_mek` (step 2) and copied back in step 3.
/// 2. Call `wrap_mek` with AAD = header[0..40] — produces `ephemeral_pubkey`,
///    `wrap_nonce`, and `wrapped_mek`.
/// 3. Fill `ephemeral_pubkey` (offset 40..72) AND `wrap_nonce` (offset 72..84)
///    into the header buffer — both come from `wrap_mek`'s return value.
/// 4. Compute `payload_aad_hash = SHA-256(header[0..112])` — now includes
///    `ephemeral_pubkey` and `wrap_nonce`, matching what
///    `decrypt_drm_container` will compute over the full header read from disk.
/// 5. Fill `payload_aad_hash` into the header buffer (offset 112..144).
/// 6. Encrypt payload with AAD = header[0..144].
/// 7. Write: header (151) + wrapped_mek (48) + payload (N) + tag (16).
pub fn write_drm_container(
    output_path: &Path,
    zip_bytes: &[u8],
    app_pubkey: &[u8; 32],
) -> Result<()> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use sha2::Digest;

    // 1. Generate a fresh MEK.
    let mek = crate::drm::generate_mek();

    // 2. Build the partial header. The `ephemeral_pubkey` (offset 40..72) and
    //    `wrap_nonce` (offset 72..84) fields are generated INSIDE `wrap_mek`
    //    (step 3) and copied back here (step 4). `payload_aad_hash` (offset
    //    112..144) is computed in step 5 after the other fields are in place.
    let pubkey_hash = crate::drm::compute_pubkey_hash(app_pubkey);
    let mut payload_nonce = [0u8; AES_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut payload_nonce);

    let mut partial = [0u8; DRM_HEADER_SIZE];
    partial[0..4].copy_from_slice(&MAGIC_A00M);
    partial[4] = CONTAINER_VERSION_DRM;
    partial[5] = KDF_ALGORITHM_HKDF_SHA256;
    partial[6] = CIPHER_ALGORITHM_AES_256_GCM;
    partial[7] = KEYWRAP_ALGORITHM_X25519_ECIES;
    partial[8..40].copy_from_slice(&pubkey_hash);
    // partial[40..72] = ephemeral_pubkey → filled in step 4
    // partial[72..84] = wrap_nonce → filled in step 4 (returned by wrap_mek)
    partial[84..96].copy_from_slice(&payload_nonce);
    partial[96..104].copy_from_slice(&u64::to_le_bytes(crate::drm::WRAPPED_MEK_LEN as u64));
    partial[104..112].copy_from_slice(&(zip_bytes.len() as u64).to_le_bytes());
    // partial[112..144] = payload_aad_hash → filled in step 5
    // partial[144..151] = reserved (stays zero)

    // 3. Wrap the MEK via ECIES with AAD = header[0..40].
    //    `wrap_mek` generates its own random wrap_nonce internally and uses it
    //    to encrypt the MEK — the returned `wrapped.wrap_nonce` is the ONLY
    //    copy of that nonce and MUST be persisted in the header so the player
    //    can re-derive it during decryption. (Pre-generating a separate
    //    wrap_nonce here would cause decryption to fail with a nonce mismatch.)
    let wrapped =
        crate::drm::wrap_mek(mek.as_slice(), app_pubkey, &partial[..DRM_MEK_WRAP_AAD_LEN])
            .context("ECIES MEK wrap failed")?;

    // 4. Fill ephemeral_pubkey AND wrap_nonce (both returned by wrap_mek) into
    //    the header buffer.
    partial[40..72].copy_from_slice(&wrapped.ephemeral_pubkey);
    partial[72..84].copy_from_slice(&wrapped.wrap_nonce);

    // 5. Compute payload_aad_hash = SHA-256(header[0..112]).
    //    IMPORTANT: this must run AFTER ephemeral_pubkey is filled in,
    //    otherwise the hash won't match what decrypt_drm_container computes
    //    over the full header read from disk.
    let mut hasher = sha2::Sha256::new();
    hasher.update(&partial[..DRM_PAYLOAD_AAD_HASH_COVERAGE]);
    let payload_aad_hash_bytes = hasher.finalize();
    let mut payload_aad_hash = [0u8; 32];
    payload_aad_hash.copy_from_slice(&payload_aad_hash_bytes);
    partial[112..144].copy_from_slice(&payload_aad_hash);

    // 6. Build the final DrmContainerHeader (for clean serialization).
    //    Note: wrap_nonce comes from `wrapped.wrap_nonce` (the nonce actually
    //    used by ECIES internally), NOT from a separate random draw.
    let header = DrmContainerHeader {
        container_version: CONTAINER_VERSION_DRM,
        kdf_algorithm: KDF_ALGORITHM_HKDF_SHA256,
        cipher_algorithm: CIPHER_ALGORITHM_AES_256_GCM,
        keywrap_algorithm: KEYWRAP_ALGORITHM_X25519_ECIES,
        pubkey_hash,
        ephemeral_pubkey: wrapped.ephemeral_pubkey,
        wrap_nonce: wrapped.wrap_nonce,
        payload_nonce,
        wrapped_mek_len: crate::drm::WRAPPED_MEK_LEN as u64,
        payload_length: zip_bytes.len() as u64,
        payload_aad_hash,
        reserved: [0u8; DRM_RESERVED_LEN],
    };

    // 7. AES-256-GCM encrypt the payload with AAD = header[0..144].
    let payload_aad = &header.to_bytes()[..DRM_PAYLOAD_AAD_LEN];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(mek.as_slice()));
    let combined = cipher
        .encrypt(
            Nonce::from_slice(&payload_nonce),
            Payload {
                msg: zip_bytes,
                aad: payload_aad,
            },
        )
        .map_err(|e| anyhow::anyhow!("AES-256-GCM payload encryption failed: {e}"))?;

    let ct_len = combined.len() - AES_TAG_LEN;
    let ciphertext = &combined[..ct_len];
    let tag = &combined[ct_len..];

    // 8. Write: header (151) + wrapped_mek (48) + payload (N) + tag (16).
    let mut file = File::create(output_path)
        .with_context(|| format!("failed to create container file: {}", output_path.display()))?;
    file.write_all(&header.to_bytes())
        .context("failed to write DRM header")?;
    file.write_all(&wrapped.wrapped_mek)
        .context("failed to write wrapped MEK")?;
    file.write_all(ciphertext)
        .context("failed to write payload ciphertext")?;
    file.write_all(tag)
        .context("failed to write payload GCM tag")?;
    file.sync_all().context("failed to sync container file")?;

    log::info!(
        "Wrote DRM .a00m container: {} ({} bytes plaintext → {} bytes ciphertext)",
        output_path.display(),
        zip_bytes.len(),
        ciphertext.len()
    );

    // mek is Zeroizing, drops here and zeroizes.
    Ok(())
}

/// Decrypt a v1.3.0 DRM container at `path` using `ctx`.
///
/// Returns the plaintext ZIP bytes. Verifies the `payload_aad_hash` (early
/// tamper detection) and the AES-GCM tag (cryptographic authentication).
pub fn decrypt_drm_container(path: &Path, ctx: &DrmDecryptContext) -> Result<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};

    let mut file =
        File::open(path).with_context(|| format!("failed to open: {}", path.display()))?;

    // 1. Read and parse the 151-byte header.
    let mut header_buf = [0u8; DRM_HEADER_SIZE];
    file.read_exact(&mut header_buf)
        .context("failed to read DRM header (file too short?)")?;
    let header = DrmContainerHeader::from_bytes(&header_buf).context("invalid DRM header")?;

    // 2. Verify payload_aad_hash == SHA-256(header[0..112]).
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&header_buf[..DRM_PAYLOAD_AAD_HASH_COVERAGE]);
    let computed_hash = hasher.finalize();
    if computed_hash.as_slice() != header.payload_aad_hash {
        bail!("payload_aad_hash mismatch: header tampered before payload_aad_hash field");
    }

    // 3. Read wrapped_mek (48 bytes).
    let wrapped_mek_len = header.wrapped_mek_len as usize;
    if wrapped_mek_len != crate::drm::WRAPPED_MEK_LEN {
        bail!(
            "unexpected wrapped_mek_len: {} (expected {})",
            wrapped_mek_len,
            crate::drm::WRAPPED_MEK_LEN
        );
    }
    let mut wrapped_mek_bytes = [0u8; crate::drm::WRAPPED_MEK_LEN];
    file.read_exact(&mut wrapped_mek_bytes)
        .context("failed to read wrapped MEK")?;

    // 4. Reconstruct WrappedMek for the drm module.
    let wrapped = crate::drm::WrappedMek {
        ephemeral_pubkey: header.ephemeral_pubkey,
        wrap_nonce: header.wrap_nonce,
        wrapped_mek: wrapped_mek_bytes,
    };

    // 5. Unwrap MEK via ECIES. AAD = header[0..96].
    let mek = crate::drm::unwrap_mek(
        &wrapped,
        &ctx.app_privkey,
        &ctx.app_pubkey,
        &header_buf[..DRM_MEK_WRAP_AAD_LEN],
    )
    .context("MEK unwrap failed")?;

    // 6. Read payload + tag.
    let payload_length = header.payload_length as usize;
    let mut ciphertext = vec![0u8; payload_length];
    file.read_exact(&mut ciphertext)
        .context("failed to read payload ciphertext")?;
    let mut tag = [0u8; AES_TAG_LEN];
    file.read_exact(&mut tag)
        .context("failed to read payload GCM tag")?;

    // 7. AES-256-GCM decrypt with AAD = header[0..144].
    let mut combined = ciphertext;
    combined.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(mek.as_slice()));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&header.payload_nonce),
            Payload {
                msg: &combined,
                aad: &header_buf[..DRM_PAYLOAD_AAD_LEN],
            },
        )
        .map_err(|_| {
            PackageError::DecryptionFailed(
                "payload decryption failed: wrong MEK or corrupted payload".into(),
            )
        })?;

    log::info!(
        "Decrypted DRM .a00m container: {} ({} bytes ciphertext → {} bytes plaintext)",
        path.display(),
        payload_length,
        plaintext.len()
    );

    // mek is Zeroizing, drops here and zeroizes.
    Ok(plaintext)
}

/// Read the container version byte from `path`.
///
/// Returns:
/// - `Ok(Some(0x12))` for v1.2.0 password-encrypted containers
/// - `Ok(Some(0x13))` for v1.3.0 DRM containers
/// - `Ok(None)` for standard ZIP files (magic `PK\x03\x04`) or non-A00M files
/// - `Err` on read failure
pub fn read_container_version(path: &Path) -> Result<Option<u8>> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open: {}", path.display()))?;
    let mut magic_and_version = [0u8; 5];
    if file.read_exact(&mut magic_and_version).is_err() {
        // File too short to be any container — treat as None.
        return Ok(None);
    }
    if magic_and_version[0..4] != MAGIC_A00M {
        return Ok(None);
    }
    Ok(Some(magic_and_version[4]))
}

/// Auto-dispatch container decryption based on the version byte.
///
/// - v1.3.0 (`0x13`) → DRM decryption via [`decrypt_drm_container`]
/// - v1.2.0 (`0x12`) → **rejected**. Password containers are no longer
///   generated or accepted in this DRM-only build; the caller must
///   re-package the file as a standard ZIP (local use) or as a v1.3.0
///   DRM container (distribution).
/// - Other / non-A00M → treat as standard ZIP, return file bytes as-is
///
/// `drm_ctx` is required for v1.3.0 containers; pass `None` if you only
/// expect standard ZIP files. The `password` argument is retained for API
/// stability but is unused — password decryption is no longer dispatched.
pub fn decrypt_container_auto(
    path: &Path,
    _password: &str,
    drm_ctx: Option<&DrmDecryptContext>,
) -> Result<Vec<u8>> {
    match read_container_version(path)? {
        Some(CONTAINER_VERSION) => bail!(
            "v1.2.0 password-protected .a00m containers are no longer supported \
             (DRM-only build). Re-package the file as a standard ZIP for local \
             use, or as a v1.3.0 DRM container for distribution."
        ),
        Some(CONTAINER_VERSION_DRM) => {
            let ctx = drm_ctx.ok_or_else(|| {
                anyhow::anyhow!(
                    "DRM container requires a DrmDecryptContext (got None) — \
                     call drm_activate first"
                )
            })?;
            decrypt_drm_container(path, ctx)
        }
        Some(other) => bail!("unsupported container version byte: 0x{other:02x}"),
        None => {
            // Standard ZIP — read the whole file as bytes.
            std::fs::read(path)
                .with_context(|| format!("failed to read standard ZIP: {}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)] // tests may use unwrap for convenience

    use super::*;

    #[test]
    fn header_round_trip() {
        let header = ContainerHeader {
            container_version: CONTAINER_VERSION,
            kdf_algorithm: KDF_ALGORITHM_ARGON2ID,
            cipher_algorithm: CIPHER_ALGORITHM_AES_256_GCM,
            kdf_salt: [0xAB; KDF_SALT_LEN],
            kdf_iterations: KDF_ITERATIONS,
            kdf_memory_kib: KDF_MEMORY_KIB,
            kdf_parallelism: KDF_PARALLELISM,
            nonce: [0xCD; AES_NONCE_LEN],
            payload_length: 0x_0001_0203_0405_0607,
        };
        let bytes = header.to_bytes();
        let parsed = ContainerHeader::from_bytes(&bytes).unwrap();
        assert_eq!(parsed.kdf_salt, header.kdf_salt);
        assert_eq!(parsed.nonce, header.nonce);
        assert_eq!(parsed.payload_length, header.payload_length);
        assert_eq!(parsed.kdf_iterations, header.kdf_iterations);
    }

    #[test]
    fn invalid_magic_rejected() {
        let mut buf = [0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(b"XXXX");
        assert!(ContainerHeader::from_bytes(&buf).is_err());
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let tmp = std::env::temp_dir().join("a00m_container_test.bin");
        let plaintext = b"hello a00m encrypted container!".repeat(100);

        write_encrypted_container(&tmp, &plaintext, "test-password").unwrap();
        let decrypted = decrypt_container(&tmp, "test-password").unwrap();
        assert_eq!(decrypted, plaintext);

        // Wrong password should fail.
        let wrong = decrypt_container(&tmp, "wrong-password");
        assert!(matches!(
            wrong,
            Err(e) if e.downcast_ref::<PackageError>()
                .is_some_and(|pe| matches!(pe, PackageError::DecryptionFailed(_)))
        ));

        let _ = std::fs::remove_file(&tmp);
    }

    // ---- v1.3.0 DRM container tests ----

    use x25519_dalek::{PublicKey, StaticSecret};

    fn gen_app_keypair() -> (StaticSecret, PublicKey) {
        let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let pubkey = PublicKey::from(&secret);
        (secret, pubkey)
    }

    #[test]
    fn drm_header_round_trip() {
        let header = DrmContainerHeader {
            container_version: CONTAINER_VERSION_DRM,
            kdf_algorithm: KDF_ALGORITHM_HKDF_SHA256,
            cipher_algorithm: CIPHER_ALGORITHM_AES_256_GCM,
            keywrap_algorithm: KEYWRAP_ALGORITHM_X25519_ECIES,
            pubkey_hash: [0xAB; DRM_PUBKEY_HASH_LEN],
            ephemeral_pubkey: [0xCD; DRM_EPHEMERAL_PUBKEY_LEN],
            wrap_nonce: [0x11; AES_NONCE_LEN],
            payload_nonce: [0x22; AES_NONCE_LEN],
            wrapped_mek_len: crate::drm::WRAPPED_MEK_LEN as u64,
            payload_length: 0x_0001_0203_0405_0607,
            payload_aad_hash: [0xEE; 32],
            reserved: [0u8; DRM_RESERVED_LEN],
        };
        let bytes = header.to_bytes();
        let parsed = DrmContainerHeader::from_bytes(&bytes).unwrap();
        assert_eq!(parsed.container_version, header.container_version);
        assert_eq!(parsed.pubkey_hash, header.pubkey_hash);
        assert_eq!(parsed.ephemeral_pubkey, header.ephemeral_pubkey);
        assert_eq!(parsed.wrap_nonce, header.wrap_nonce);
        assert_eq!(parsed.payload_nonce, header.payload_nonce);
        assert_eq!(parsed.wrapped_mek_len, header.wrapped_mek_len);
        assert_eq!(parsed.payload_length, header.payload_length);
        assert_eq!(parsed.payload_aad_hash, header.payload_aad_hash);
    }

    #[test]
    fn drm_header_rejects_wrong_magic() {
        let mut buf = [0u8; DRM_HEADER_SIZE];
        buf[0..4].copy_from_slice(b"XXXX");
        buf[4] = CONTAINER_VERSION_DRM;
        assert!(DrmContainerHeader::from_bytes(&buf).is_err());
    }

    #[test]
    fn drm_header_rejects_wrong_version() {
        let mut buf = [0u8; DRM_HEADER_SIZE];
        buf[0..4].copy_from_slice(&MAGIC_A00M);
        buf[4] = CONTAINER_VERSION; // v1.2.0, not v1.3.0
        assert!(DrmContainerHeader::from_bytes(&buf).is_err());
    }

    #[test]
    fn drm_container_round_trip() {
        let (app_secret, app_pubkey) = gen_app_keypair();
        let app_pubkey_bytes = app_pubkey.to_bytes();
        let app_privkey_bytes = app_secret.to_bytes();

        let tmp = std::env::temp_dir().join("a00m_drm_roundtrip_test.bin");
        let plaintext = b"hello DRM protected container!".repeat(100);

        write_drm_container(&tmp, &plaintext, &app_pubkey_bytes).unwrap();

        let ctx = DrmDecryptContext {
            app_privkey: app_privkey_bytes,
            app_pubkey: app_pubkey_bytes,
        };
        let decrypted = decrypt_drm_container(&tmp, &ctx).unwrap();
        assert_eq!(decrypted, plaintext);

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn drm_container_wrong_privkey_fails() {
        let (_, app_pubkey) = gen_app_keypair();
        let (other_secret, _) = gen_app_keypair();

        let tmp = std::env::temp_dir().join("a00m_drm_wrong_privkey_test.bin");
        let plaintext = b"secret data".repeat(50);

        write_drm_container(&tmp, &plaintext, &app_pubkey.to_bytes()).unwrap();

        let ctx = DrmDecryptContext {
            app_privkey: other_secret.to_bytes(),
            app_pubkey: app_pubkey.to_bytes(),
        };
        let result = decrypt_drm_container(&tmp, &ctx);
        assert!(result.is_err());

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_container_version_dispatches_correctly() {
        // v1.2.0 container
        let tmp_v12 = std::env::temp_dir().join("a00m_version_v12.bin");
        write_encrypted_container(&tmp_v12, b"data", "pw").unwrap();
        assert_eq!(
            read_container_version(&tmp_v12).unwrap(),
            Some(CONTAINER_VERSION)
        );

        // v1.3.0 DRM container
        let (_, app_pubkey) = gen_app_keypair();
        let tmp_v13 = std::env::temp_dir().join("a00m_version_v13.bin");
        write_drm_container(&tmp_v13, b"data", &app_pubkey.to_bytes()).unwrap();
        assert_eq!(
            read_container_version(&tmp_v13).unwrap(),
            Some(CONTAINER_VERSION_DRM)
        );

        // Standard ZIP file (PK\x03\x04 magic)
        let tmp_zip = std::env::temp_dir().join("a00m_version_zip.bin");
        std::fs::write(&tmp_zip, b"PK\x03\x04rest of zip data").unwrap();
        assert_eq!(read_container_version(&tmp_zip).unwrap(), None);

        let _ = std::fs::remove_file(&tmp_v12);
        let _ = std::fs::remove_file(&tmp_v13);
        let _ = std::fs::remove_file(&tmp_zip);
    }

    #[test]
    fn decrypt_container_auto_dispatches_all_formats() {
        // v1.3.0 DRM format
        let (app_secret, app_pubkey) = gen_app_keypair();
        let tmp_v13 = std::env::temp_dir().join("a00m_auto_v13.bin");
        let plaintext_v13 = b"drm protected".repeat(20);
        write_drm_container(&tmp_v13, &plaintext_v13, &app_pubkey.to_bytes()).unwrap();
        let ctx = DrmDecryptContext {
            app_privkey: app_secret.to_bytes(),
            app_pubkey: app_pubkey.to_bytes(),
        };
        let decrypted_v13 = decrypt_container_auto(&tmp_v13, "", Some(&ctx)).unwrap();
        assert_eq!(decrypted_v13, plaintext_v13);

        // Standard ZIP
        let tmp_zip = std::env::temp_dir().join("a00m_auto_zip.bin");
        let plaintext_zip = b"PK\x03\x04standard zip data".to_vec();
        std::fs::write(&tmp_zip, &plaintext_zip).unwrap();
        let decrypted_zip = decrypt_container_auto(&tmp_zip, "", None).unwrap();
        assert_eq!(decrypted_zip, plaintext_zip);

        let _ = std::fs::remove_file(&tmp_v13);
        let _ = std::fs::remove_file(&tmp_zip);
    }

    #[test]
    fn decrypt_container_auto_rejects_v12() {
        // v1.2.0 password format — no longer supported in the DRM-only build.
        // The dispatcher must reject these with a clear error rather than
        // attempting password decryption.
        let tmp_v12 = std::env::temp_dir().join("a00m_auto_reject_v12.bin");
        let plaintext_v12 = b"password protected".repeat(20);
        write_encrypted_container(&tmp_v12, &plaintext_v12, "secret-pw").unwrap();

        let result = decrypt_container_auto(&tmp_v12, "secret-pw", None);
        assert!(
            result.is_err(),
            "v1.2.0 containers must be rejected in DRM-only build"
        );
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("no longer supported"),
            "expected a clear 'no longer supported' error message, got: {err_msg}"
        );

        let _ = std::fs::remove_file(&tmp_v12);
    }

    #[test]
    fn decrypt_drm_without_ctx_returns_error() {
        let (_, app_pubkey) = gen_app_keypair();
        let tmp = std::env::temp_dir().join("a00m_drm_no_ctx_test.bin");
        write_drm_container(&tmp, b"data", &app_pubkey.to_bytes()).unwrap();

        // Calling decrypt_container_auto with drm_ctx=None on a DRM container
        // should return an error (not panic).
        let result = decrypt_container_auto(&tmp, "", None);
        assert!(result.is_err());

        let _ = std::fs::remove_file(&tmp);
    }
}
