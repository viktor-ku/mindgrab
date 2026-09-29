//! Allocation-free preflight for the schema-v1 subset of Yjs V1. Bounds counts,
//! nesting and clock arithmetic before Yrs allocates attacker-declared lengths.
use super::super::ApiError;

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], ApiError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or(ApiError::InvalidUpdate)?;
        let result = self
            .bytes
            .get(self.offset..end)
            .ok_or(ApiError::InvalidUpdate)?;
        self.offset = end;
        Ok(result)
    }

    fn byte(&mut self) -> Result<u8, ApiError> {
        Ok(self.take(1)?[0])
    }

    fn var(&mut self) -> Result<u32, ApiError> {
        let mut value = 0;
        for shift in (0..35).step_by(7) {
            let byte = self.byte()?;
            if shift == 28 && byte > 15 {
                return Err(ApiError::InvalidUpdate);
            }
            value |= u32::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(value);
            }
        }
        Err(ApiError::InvalidUpdate)
    }

    fn count(&mut self) -> Result<u32, ApiError> {
        let count = self.var()?;
        if count as usize > self.bytes.len() - self.offset || count > 200_000 {
            return Err(ApiError::ResourceLimit);
        }
        Ok(count)
    }

    fn string(&mut self) -> Result<&'a str, ApiError> {
        let len = self.var()?;
        std::str::from_utf8(self.take(len as usize)?).map_err(|_| ApiError::InvalidUpdate)
    }

    fn id(&mut self) -> Result<(), ApiError> {
        self.var()?;
        self.var()?;
        Ok(())
    }

    fn any(&mut self, depth: u8) -> Result<(), ApiError> {
        if depth > 16 {
            return Err(ApiError::ResourceLimit);
        }
        match self.byte()? {
            120 | 121 | 126 | 127 => {}
            125 => {
                // lib0 signed varint has a 6-bit first byte, then 7-bit bytes.
                for index in 0..8 {
                    if self.byte()? < 128 {
                        return Ok(());
                    }
                    if index == 7 {
                        return Err(ApiError::InvalidUpdate);
                    }
                }
            }
            124 => {
                self.take(4)?;
            }
            122 | 123 => {
                self.take(8)?;
            }
            119 => {
                self.string()?;
            }
            kind @ (117 | 118) => {
                for _ in 0..self.count()? {
                    if kind == 118 {
                        self.string()?;
                    }
                    self.any(depth + 1)?;
                }
            }
            116 => {
                let len = self.var()?;
                self.take(len as usize)?;
            }
            _ => return Err(ApiError::InvalidUpdate),
        }
        Ok(())
    }
}

pub(super) fn preflight(bytes: &[u8]) -> Result<(), ApiError> {
    let mut reader = Reader { bytes, offset: 0 };
    let mut clients = std::collections::HashSet::new();
    for _ in 0..reader.count()? {
        let count = reader.count()?;
        let client = reader.var()?;
        if !clients.insert(client) {
            return Err(ApiError::InvalidUpdate);
        }
        let mut clock = reader.var()?;
        for _ in 0..count {
            let info = reader.byte()?;
            let len = if info == 0 || info == 10 {
                reader.var()?
            } else {
                if info & 128 != 0 {
                    reader.id()?;
                }
                if info & 64 != 0 {
                    reader.id()?;
                }
                if info & 192 == 0 {
                    match reader.var()? {
                        1 => {
                            reader.string()?;
                        }
                        0 => {
                            reader.id()?;
                        }
                        _ => return Err(ApiError::InvalidUpdate),
                    }
                    if info & 32 != 0 {
                        reader.string()?;
                    }
                }
                match info & 15 {
                    1 => reader.var()?,
                    4 => reader.string()?.encode_utf16().count() as u32,
                    7 => {
                        // Only Y.Map (1) and Y.Text (2), never XML/subdocuments.
                        if !matches!(reader.byte()?, 1 | 2) {
                            return Err(ApiError::InvalidSchema);
                        }
                        1
                    }
                    8 => {
                        let len = reader.count()?;
                        for _ in 0..len {
                            reader.any(0)?;
                        }
                        len
                    }
                    _ => return Err(ApiError::InvalidSchema),
                }
            };
            if len == 0 {
                return Err(ApiError::InvalidUpdate);
            }
            clock = clock.checked_add(len).ok_or(ApiError::InvalidUpdate)?;
        }
    }
    clients.clear();
    for _ in 0..reader.count()? {
        if !clients.insert(reader.var()?) {
            return Err(ApiError::InvalidUpdate);
        }
        for _ in 0..reader.count()? {
            let start = reader.var()?;
            start
                .checked_add(reader.var()?)
                .ok_or(ApiError::InvalidUpdate)?;
        }
    }
    if reader.offset != bytes.len() {
        return Err(ApiError::InvalidUpdate);
    }
    Ok(())
}
