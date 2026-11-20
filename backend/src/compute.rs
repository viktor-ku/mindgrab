//! Bounds the document work that decodes and encodes whole projects, so a burst
//! of requests on large maps cannot take every core. Callers hold no database
//! connection while they wait here or compute.

use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Enough for one browser's open map and its background sync.
const PER_ACCOUNT: usize = 2;
/// Short bursts wait their turn; anything longer is told to come back.
const QUEUE: Duration = Duration::from_secs(3);

type Accounts = Arc<Mutex<HashMap<i64, Arc<Semaphore>>>>;

pub struct Compute {
    all: Arc<Semaphore>,
    accounts: Accounts,
}
/// An account's place among its own requests, forgotten once nothing uses it.
struct Seat {
    accounts: Accounts,
    account: i64,
    permit: Option<OwnedSemaphorePermit>,
}
impl Drop for Seat {
    fn drop(&mut self) {
        let mut accounts = self.accounts.lock().unwrap();
        self.permit.take();
        // Holders and waiters each keep a reference; the map keeps the last one.
        if accounts
            .get(&self.account)
            .is_some_and(|seats| Arc::strong_count(seats) == 1)
        {
            accounts.remove(&self.account);
        }
    }
}
pub struct Permit {
    _all: OwnedSemaphorePermit,
    _seat: Seat,
}

impl Compute {
    pub fn new() -> Self {
        let cores = std::thread::available_parallelism().map_or(2, |cores| cores.get());
        Self {
            all: Arc::new(Semaphore::new(cores)),
            accounts: Accounts::default(),
        }
    }
    /// Waits briefly for a turn, then answers 429, which clients retry.
    pub async fn acquire(&self, account: i64) -> Result<Arc<Permit>> {
        let turn = async {
            let seats = self
                .accounts
                .lock()
                .unwrap()
                .entry(account)
                .or_insert_with(|| Arc::new(Semaphore::new(PER_ACCOUNT)))
                .clone();
            let mut seat = Seat {
                accounts: self.accounts.clone(),
                account,
                permit: None,
            };
            seat.permit = seats.acquire_owned().await.ok();
            // The account's turn comes first, so its queue cannot crowd out others here.
            let all = self.all.clone().acquire_owned().await.ok()?;
            Some(Arc::new(Permit {
                _all: all,
                _seat: seat,
            }))
        };
        tokio::time::timeout(QUEUE, turn)
            .await
            .map_err(|_| ApiError::busy())?
            .ok_or_else(ApiError::unavailable)
    }
}

/// Runs CPU work off the async executor. The permit travels with the work, so
/// work whose request has gone away still counts until its thread is free.
pub async fn run<T: Send + 'static>(
    permit: &Arc<Permit>,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = permit.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| ApiError::unavailable())?
}
