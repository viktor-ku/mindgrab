//! Bounded envelope decoding before any Yrs allocation. Awareness is ignored.
use super::super::ApiError;

pub(super) enum Frame<'a> {
    Step1(&'a [u8]),
    Update(&'a [u8]),
    Awareness,
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn uint(&mut self) -> Result<u32, ApiError> {
        let mut value = 0;
        for shift in (0..35).step_by(7) {
            let (&byte, rest) = self.0.split_first().ok_or(ApiError::InvalidRequest)?;
            self.0 = rest;
            if shift == 28 && byte > 15 {
                return Err(ApiError::InvalidRequest);
            }
            value |= u32::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(value);
            }
        }
        Err(ApiError::InvalidRequest)
    }
    fn buffer(&mut self) -> Result<&'a [u8], ApiError> {
        let length = self.uint()? as usize;
        if length > self.0.len() {
            return Err(ApiError::InvalidRequest);
        }
        let (buffer, rest) = self.0.split_at(length);
        self.0 = rest;
        Ok(buffer)
    }
    fn end(&self) -> Result<(), ApiError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(ApiError::InvalidRequest)
        }
    }
}

pub(super) fn decode(bytes: &[u8]) -> Result<Frame<'_>, ApiError> {
    let mut reader = Reader(bytes);
    let message = match reader.uint()? {
        0 => {
            let kind = reader.uint()?;
            let bytes = reader.buffer()?;
            match kind {
                0 => {
                    let mut vector = Reader(bytes);
                    let count = vector.uint()?;
                    if count > 10_000 {
                        return Err(ApiError::ResourceLimit);
                    }
                    for _ in 0..count {
                        vector.uint()?;
                        vector.uint()?;
                    }
                    vector.end()?;
                    Frame::Step1(bytes)
                }
                1 | 2 => Frame::Update(bytes),
                _ => return Err(ApiError::InvalidRequest),
            }
        }
        1 => {
            reader.buffer()?;
            Frame::Awareness
        }
        3 => Frame::Awareness,
        _ => return Err(ApiError::InvalidRequest),
    };
    reader.end()?;
    Ok(message)
}
