//! AES-256-GCM for secrets the backend keeps in Postgres but must read back,
//! such as WorkOS tokens. The keys live outside the database, so a copy of it
//! alone reveals none of them.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};

const NONCE_LEN: usize = 12;

/// Every key that may have sealed a stored value, by id. The first one seals
/// new values. To rotate, put a new key first and keep the old one until every
/// value it sealed has been replaced or has expired.
#[derive(Clone)]
pub struct Keys(Vec<(String, Aes256Gcm)>);

impl Keys {
    /// Parses `TOKEN_KEYS`: entries `<id>:<base64 of 32 bytes>`, separated by
    /// commas or whitespace. `openssl rand -base64 32` makes a key.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let mut keys: Vec<(String, Aes256Gcm)> = Vec::new();
        for entry in value
            .split([',', ' ', '\t', '\n'])
            .filter(|e| !e.is_empty())
        {
            let (id, key) = entry
                .split_once(':')
                .ok_or("TOKEN_KEYS entries must be <id>:<base64 key>")?;
            if id.is_empty()
                || id.len() > 16
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err("TOKEN_KEYS ids must be 1 to 16 letters, digits, - or _");
            }
            if keys.iter().any(|(other, _)| other == id) {
                return Err("TOKEN_KEYS ids must be unique");
            }
            let key = STANDARD
                .decode(key)
                .ok()
                .filter(|key| key.len() == 32)
                .ok_or("TOKEN_KEYS keys must be 32 bytes in base64")?;
            keys.push((id.to_owned(), Aes256Gcm::new_from_slice(&key).unwrap()));
        }
        if keys.is_empty() {
            return Err("TOKEN_KEYS must name at least one key");
        }
        Ok(Self(keys))
    }
    /// A fixed key for local authentication, whose tokens are not secret.
    pub(crate) fn development() -> Self {
        Self(vec![(
            "dev".into(),
            Aes256Gcm::new_from_slice(&[0; 32]).unwrap(),
        )])
    }
    /// `<key id>.<base64url of nonce and ciphertext>`. `context` is
    /// authenticated but not stored: opening needs the same one, so a sealed
    /// value moved to another row or column does not open.
    pub fn seal(&self, plaintext: &str, context: &str) -> String {
        let (id, cipher) = &self.0[0];
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let mut sealed = nonce.to_vec();
        sealed.extend(
            cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: plaintext.as_bytes(),
                        aad: context.as_bytes(),
                    },
                )
                .expect("AES-GCM encrypts any token-sized input"),
        );
        format!("{id}.{}", URL_SAFE_NO_PAD.encode(sealed))
    }
    /// `None` when the value is malformed, was sealed with a key no longer
    /// listed, or for another context.
    pub fn open(&self, sealed: &str, context: &str) -> Option<String> {
        let (id, data) = sealed.split_once('.')?;
        let (_, cipher) = self.0.iter().find(|(key, _)| key == id)?;
        let data = URL_SAFE_NO_PAD.decode(data).ok()?;
        if data.len() < NONCE_LEN {
            return None;
        }
        let (nonce, ciphertext) = data.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
        let plaintext = cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: context.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plaintext).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const TWO: &str = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";

    #[test]
    fn seals_with_the_first_key_and_opens_with_any() {
        let old = Keys::parse(&format!("old:{ONE}")).unwrap();
        let rotated = Keys::parse(&format!("new:{TWO}, old:{ONE}")).unwrap();
        let sealed = old.seal("refresh_abc", "ctx");
        assert!(sealed.starts_with("old."));
        assert!(!sealed.contains("refresh_abc"));
        assert_ne!(sealed, old.seal("refresh_abc", "ctx"));
        assert_eq!(rotated.open(&sealed, "ctx").as_deref(), Some("refresh_abc"));
        let resealed = rotated.seal("refresh_abc", "ctx");
        assert!(resealed.starts_with("new."));
        assert_eq!(old.open(&resealed, "ctx"), None);
    }

    #[test]
    fn refuses_another_context_and_tampering() {
        let keys = Keys::parse(&format!("k1:{ONE}")).unwrap();
        let sealed = keys.seal("token", "access_token a");
        assert_eq!(keys.open(&sealed, "access_token b"), None);
        assert_eq!(keys.open(&sealed, "refresh_token a"), None);
        let mut tampered = sealed.clone().into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert_eq!(
            keys.open(&String::from_utf8(tampered).unwrap(), "access_token a"),
            None
        );
        for malformed in ["", "k1", "k1.", "k1.AAAA", "token", "eyJhbGciOi.x"] {
            assert_eq!(keys.open(malformed, "access_token a"), None);
        }
    }

    #[test]
    fn parsing_rejects_bad_keys() {
        assert!(Keys::parse("").is_err());
        assert!(Keys::parse(ONE).is_err());
        assert!(Keys::parse(&format!(":{ONE}")).is_err());
        assert!(Keys::parse(&format!("a.b:{ONE}")).is_err());
        assert!(Keys::parse("k1:AQEB").is_err());
        assert!(Keys::parse(&format!("k1:{ONE},k1:{TWO}")).is_err());
        assert!(Keys::parse(&format!("k1:{ONE}\nk2:{TWO}")).is_ok());
    }
}
