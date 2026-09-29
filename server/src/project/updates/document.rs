use yrs::types::ToJson;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{Any, Doc, Map, OffsetKind, Options, Out, ReadTxn, Text, Transact, Update};

use super::{
    super::{ApiError, projection::Content},
    MAX_DOCUMENT_BYTES,
    wire::preflight,
};

pub(super) struct Candidate {
    pub bytes: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub validation: &'static str,
    pub content: Option<Content>,
}

fn node_id(id: &str) -> bool {
    super::super::parse_project_id(id).is_ok_and(|id| {
        id.get_variant() == uuid::Variant::RFC4122
            && id.get_version_num() >= 1
            && id.get_version_num() <= 8
    })
}

fn valid_rank(rank: &str) -> bool {
    let bytes = rank.as_bytes();
    let Some(head) = bytes.first() else {
        return false;
    };
    let integer_len = match head {
        b'a'..=b'z' => usize::from(head - b'a') + 2,
        b'A'..=b'Z' => usize::from(b'Z' - head) + 2,
        _ => return false,
    };
    bytes.len() >= integer_len
        && bytes.len() <= 128
        && bytes[1..].iter().all(u8::is_ascii_alphanumeric)
        && !(bytes.len() == integer_len
            && head == &b'A'
            && bytes[1..integer_len].iter().all(|b| *b == b'0'))
        && (bytes.len() == integer_len || bytes.last() != Some(&b'0'))
}

fn schema(doc: &Doc) -> Result<Content, ApiError> {
    let txn = doc.transact();
    if txn.root_refs().count() != 1 {
        return Err(ApiError::InvalidSchema);
    }
    let root = txn.get_map("project").ok_or(ApiError::InvalidSchema)?;
    if root.len(&txn) != 3
        || root
            .keys(&txn)
            .any(|key| !["schemaVersion", "metadata", "nodes"].contains(&key))
    {
        return Err(ApiError::InvalidSchema);
    }
    if !matches!(
        root.get(&txn, "schemaVersion"),
        Some(Out::Any(Any::Number(_)))
    ) {
        return Err(ApiError::InvalidSchema);
    }
    let Some(Out::YMap(metadata)) = root.get(&txn, "metadata") else {
        return Err(ApiError::InvalidSchema);
    };
    if metadata.len(&txn) != 1 {
        return Err(ApiError::InvalidSchema);
    }
    if !matches!(metadata.get(&txn, "name"), Some(Out::Any(Any::String(_)))) {
        return Err(ApiError::InvalidSchema);
    }
    let Some(Out::YMap(nodes)) = root.get(&txn, "nodes") else {
        return Err(ApiError::InvalidSchema);
    };
    if nodes.len(&txn) > 10_000 {
        return Err(ApiError::ResourceLimit);
    }
    for (_, node) in nodes.iter(&txn) {
        let Out::YMap(node) = node else {
            return Err(ApiError::InvalidSchema);
        };
        // Reject extra shared structures before recursive JSON materialization.
        if node
            .keys(&txn)
            .any(|key| !["text", "placement", "position", "color", "deleted"].contains(&key))
        {
            return Err(ApiError::InvalidSchema);
        }
        if !matches!(node.get(&txn, "color"), Some(Out::Any(Any::String(_))))
            || !matches!(node.get(&txn, "deleted"), Some(Out::Any(Any::Bool(_))))
        {
            return Err(ApiError::InvalidSchema);
        }
        let Some(Out::YText(text)) = node.get(&txn, "text") else {
            return Err(ApiError::InvalidSchema);
        };
        if text.len(&txn) > 65_536 {
            return Err(ApiError::ResourceLimit);
        }
        if text.diff(&txn, |_| ()).iter().any(|part| {
            part.attributes.is_some() || !matches!(&part.insert, Out::Any(Any::String(_)))
        }) {
            return Err(ApiError::InvalidSchema);
        }
        if !matches!(node.get(&txn, "placement"), Some(Out::Any(Any::Map(p))) if p.contains_key("parent"))
            || node
                .get(&txn, "position")
                .is_some_and(|p| !matches!(p, Out::Any(Any::Map(_))))
        {
            return Err(ApiError::InvalidSchema);
        }
    }
    let mut json = String::new();
    root.to_json(&txn).to_json(&mut json);
    let content: Content = serde_json::from_str(&json).map_err(|_| ApiError::InvalidSchema)?;
    if content.schema_version != 1 {
        return Err(ApiError::UnsupportedSchema);
    }
    if content.metadata.name.len() > 200 {
        return Err(ApiError::ResourceLimit);
    }
    if content.metadata.name.trim().is_empty() {
        return Err(ApiError::InvalidSchema);
    }
    for (id, node) in &content.nodes {
        if node.text.encode_utf16().count() > 65_536 || node.placement.rank.len() > 128 {
            return Err(ApiError::ResourceLimit);
        }
        if !node_id(id)
            || !valid_rank(&node.placement.rank)
            || node
                .placement
                .parent
                .as_deref()
                .is_some_and(|id| !node_id(id))
            || ![
                "blue", "teal", "green", "amber", "orange", "rose", "violet", "slate",
            ]
            .contains(&node.color.as_str())
            || node
                .position
                .as_ref()
                .is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
        {
            return Err(ApiError::InvalidSchema);
        }
        // Deserialization validates the boolean even though projection uses it later.
        let _ = node.deleted;
    }
    Ok(content)
}

/// Merge original bytes before applying to a fresh document. Never replay a
/// gapped log into a cached room or build a baseline from observer output.
pub(super) fn reconstruct(updates: Vec<Vec<u8>>) -> Result<Candidate, ApiError> {
    let mut decoded = Vec::with_capacity(updates.len());
    for bytes in updates {
        preflight(&bytes)?;
        decoded.push(Update::decode_v1(&bytes).map_err(|_| ApiError::InvalidUpdate)?);
    }
    let merged = Update::merge_updates(decoded);
    let contiguous = merged.state_vector();
    // has_missing_updates alone misses independent blocks behind Skip (#673).
    let hole = merged.insertions(true).iter().any(|(client, ranges)| {
        ranges
            .iter()
            .any(|range| range.end > contiguous.get(client))
    });
    let bytes = merged.encode_v1();
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(ApiError::ResourceLimit);
    }
    let doc = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    doc.transact_mut()
        .apply_update(merged)
        .map_err(|_| ApiError::InvalidUpdate)?;
    let txn = doc.transact();
    let pending = hole || txn.has_missing_updates();
    let state_vector = txn.state_vector().encode_v1();
    drop(txn);
    let content = if pending { None } else { Some(schema(&doc)?) };
    Ok(Candidate {
        bytes,
        state_vector,
        content,
        validation: if pending {
            "pending_dependencies"
        } else {
            "valid"
        },
    })
}

pub(super) async fn candidate(updates: Vec<Vec<u8>>) -> Result<Candidate, ApiError> {
    static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let permit = WORKERS.acquire().await.map_err(|_| ApiError::Unavailable)?;
    // Keep at most two decoded candidates resident across all project locks.
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| reconstruct(updates)).unwrap_or(Err(ApiError::InvalidUpdate))
    })
    .await
    .map_err(|_| ApiError::Unavailable)?;
    drop(permit);
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn ranks_accept_the_default_alphabet_and_fractional_minimum() {
        for rank in ["a0", "a0V", "Zz", "A00000000000000000000000000V"] {
            assert!(super::valid_rank(rank), "{rank}");
        }
        for rank in ["", "a", "a00", "a0_", "A00000000000000000000000000"] {
            assert!(!super::valid_rank(rank), "{rank}");
        }
    }
}
