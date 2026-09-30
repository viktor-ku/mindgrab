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
    /// Only present after proving coverage of every source insertion and delete.
    pub checkpoint: Option<Vec<u8>>,
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
fn build(updates: Vec<Vec<u8>>, checkpoint: bool) -> Result<Candidate, ApiError> {
    let mut decoded = Vec::with_capacity(updates.len());
    let mut insertions = yrs::IdSet::new();
    let mut deletes = yrs::IdSet::new();
    for bytes in updates {
        preflight(&bytes)?;
        let update = Update::decode_v1(&bytes).map_err(|_| ApiError::InvalidUpdate)?;
        insertions.merge_with(update.insertions(true));
        deletes.merge_with(update.delete_set().clone());
        decoded.push(update);
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
        skip_gc: true,
        ..Options::default()
    });
    doc.transact_mut()
        .apply_update(merged)
        .map_err(|_| ApiError::InvalidUpdate)?;
    let txn = doc.transact();
    let pending = hole || txn.has_missing_updates();
    let applied_vector = txn.state_vector();
    let state_vector = applied_vector.encode_v1();
    drop(txn);
    let content = if pending { None } else { Some(schema(&doc)?) };
    // #670/#673: neither successful encoding nor has_missing_updates proves
    // coverage. Compare ALL original ranges (including GC) and delete sets with
    // the full re-encoding, not just the merged contiguous vector. GC stays off
    // so surviving item payloads/identities are not recreated from JSON.
    let checkpoint = if checkpoint && !pending {
        let encoded = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        let check = Update::decode_v1(&encoded).map_err(|_| ApiError::InvalidUpdate)?;
        if encoded.len() <= MAX_DOCUMENT_BYTES
            && check.insertions(true) == insertions
            && deletes.diff(check.delete_set()).is_empty()
            && check.state_vector() == contiguous
            // Encoding order is not canonical, even for equal client clocks.
            && check.state_vector() == applied_vector
        {
            let fresh = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                skip_gc: true,
                ..Options::default()
            });
            fresh
                .transact_mut()
                .apply_update(check)
                .map_err(|_| ApiError::InvalidUpdate)?;
            // The publication must also survive our production preflight and
            // merge/reconstruct path, not merely a direct apply of decoded bytes.
            // Yrs can encode states outside that path's safe subset.
            let replay = reconstruct(vec![encoded.clone()]);
            if !fresh.transact().has_missing_updates()
                && schema(&fresh)? == *content.as_ref().unwrap()
                && replay.is_ok_and(|c| c.validation == "valid" && c.content == content)
            {
                Some(encoded)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    Ok(Candidate {
        bytes,
        state_vector,
        content,
        checkpoint,
        validation: if pending {
            "pending_dependencies"
        } else {
            "valid"
        },
    })
}

pub(super) fn reconstruct(updates: Vec<Vec<u8>>) -> Result<Candidate, ApiError> {
    build(updates, false)
}

pub(super) async fn candidate(updates: Vec<Vec<u8>>) -> Result<Candidate, ApiError> {
    bounded(updates, false).await
}

pub(super) async fn checkpoint_candidate(updates: Vec<Vec<u8>>) -> Result<Candidate, ApiError> {
    bounded(updates, true).await
}

async fn bounded(updates: Vec<Vec<u8>>, checkpoint: bool) -> Result<Candidate, ApiError> {
    static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let permit = WORKERS.acquire().await.map_err(|_| ApiError::Unavailable)?;
    // Keep at most two decoded candidates resident across all project locks.
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| {
            if checkpoint {
                build(updates, true)
            } else {
                reconstruct(updates)
            }
        })
        .unwrap_or(Err(ApiError::InvalidUpdate))
    })
    .await
    .map_err(|_| ApiError::Unavailable)?;
    drop(permit);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_multi_client_history_always_produces_a_checkpoint() {
        let initial = super::super::tests::INITIAL.to_vec();
        // Clients 1 (fixture) and 17 collide in the state-vector hash buckets;
        // equivalent vectors can encode in different orders after reconstruction.
        let doc = Doc::with_options(Options {
            client_id: yrs::block::ClientID::new(17),
            offset_kind: OffsetKind::Utf16,
            skip_gc: true,
            ..Options::default()
        });
        doc.transact_mut()
            .apply_update(Update::decode_v1(&initial).unwrap())
            .unwrap();
        let metadata = {
            let txn = doc.transact();
            let root = txn.get_map("project").unwrap();
            let Some(Out::YMap(metadata)) = root.get(&txn, "metadata") else {
                panic!("missing metadata")
            };
            metadata
        };
        let edit = {
            let mut txn = doc.transact_mut();
            metadata.insert(&mut txn, "name", "Two clients");
            txn.encode_update_v1()
        };
        let expected = schema(&doc).unwrap();
        // Repeated reconstruction must preserve both clients and deletions.
        for _ in 0..64 {
            let candidate = build(vec![initial.clone(), edit.clone()], true).unwrap();
            assert_eq!(candidate.validation, "valid");
            let checkpoint = candidate.checkpoint.expect("complete history is covered");
            assert_eq!(
                reconstruct(vec![checkpoint]).unwrap().content,
                Some(expected.clone())
            );
        }
    }

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
