//! Slow tide: the alternative speed limits. On by hand, or by a weekly schedule of hours, so
//! Riptide can stay out of the way during calls and work, and run flat out overnight.

use serde::Serialize;

/// Hours in the schedule: Monday 00:00 first, Sunday 23:00 last.
pub const WEEK_HOURS: usize = 7 * 24;

/// Whether slow tide is on, and why, as snapshots report it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TideState {
    pub on: bool,
    /// Set by the schedule (no switch by hand is in force).
    pub scheduled: bool,
    /// Switched by hand against the schedule, until `next_change`.
    pub overridden: bool,
    /// Unix ms of the schedule's next change, while it's followed.
    pub next_change: Option<u64>,
}

/// Inputs to slow tide's state, all from the settings.
pub struct TidePlan<'a> {
    /// On by hand, when there's no schedule.
    pub manual: bool,
    /// Follow `hours`.
    pub follow: bool,
    pub hours: &'a [bool],
    /// A switch by hand while following the schedule: the state it chose and the Unix ms
    /// until which it holds (the schedule's next change when it was made).
    pub override_: Option<(bool, u64)>,
}

/// The hour of the week (Monday 00:00 = 0) at Unix time `secs`, in local time.
pub fn local_hour_of_week(secs: i64) -> usize {
    let t: libc::time_t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return 0;
    }
    // tm_wday counts from Sunday
    let day = (tm.tm_wday as usize + 6) % 7;
    day * 24 + tm.tm_hour as usize
}

/// Slow tide's state at `now_ms`. `hour_of` maps Unix seconds to the hour of the week, so tests
/// can fix the clock and the time zone.
pub fn state_at(plan: &TidePlan, now_ms: u64, hour_of: impl Fn(i64) -> usize) -> TideState {
    if !plan.follow {
        return TideState { on: plan.manual, scheduled: false, overridden: false, next_change: None };
    }
    let secs = (now_ms / 1000) as i64;
    let slot = |s: i64| plan.hours.get(hour_of(s) % WEEK_HOURS).copied().unwrap_or(false);
    let scheduled = slot(secs);

    // The next hour boundary where the schedule flips, within a week
    let first = secs - secs.rem_euclid(3600) + 3600;
    let next_change = (0..WEEK_HOURS as i64).map(|h| first + h * 3600).find(|&s| slot(s) != scheduled).map(|s| s as u64 * 1000);

    // A switch by hand holds until the schedule's next change
    match plan.override_ {
        Some((on, until)) if now_ms < until => TideState { on, scheduled: false, overridden: on != scheduled, next_change },
        _ => TideState { on: scheduled, scheduled, overridden: false, next_change },
    }
}

/// The default schedule: weekdays from 09:00 to 18:00.
pub fn working_hours() -> Vec<bool> {
    (0..WEEK_HOURS).map(|h| h / 24 < 5 && (9..18).contains(&(h % 24))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 3600 * 1000;

    /// A clock where Unix second 0 is Monday 00:00.
    fn fixed(s: i64) -> usize {
        (s.rem_euclid(WEEK_HOURS as i64 * 3600) / 3600) as usize
    }

    fn plan(hours: &[bool], override_: Option<(bool, u64)>) -> TidePlan<'_> {
        TidePlan { manual: false, follow: true, hours, override_ }
    }

    #[test]
    fn the_schedule_switches_on_during_its_hours() {
        let hours = working_hours();
        let s = state_at(&plan(&hours, None), 10 * H, fixed);
        assert!(s.on && s.scheduled && !s.overridden);
        // Off again at 18:00 the same day, on again at 09:00 the next
        assert_eq!(s.next_change, Some(18 * H));
        let evening = state_at(&plan(&hours, None), 20 * H, fixed);
        assert!(!evening.on);
        assert_eq!(evening.next_change, Some((24 + 9) * H));
    }

    #[test]
    fn a_switch_by_hand_holds_until_the_next_change() {
        let hours = working_hours();
        let p = plan(&hours, Some((false, 18 * H)));
        let s = state_at(&p, 10 * H, fixed);
        assert!(!s.on && s.overridden);
        // After 18:00 the schedule rules again (off), and at 09:00 it's back on
        assert!(!state_at(&p, 19 * H, fixed).overridden);
        assert!(state_at(&p, (24 + 10) * H, fixed).on);
    }

    #[test]
    fn without_a_schedule_the_manual_switch_rules() {
        let hours = working_hours();
        let p = TidePlan { manual: true, follow: false, hours: &hours, override_: None };
        assert_eq!(state_at(&p, 20 * H, fixed), TideState { on: true, scheduled: false, overridden: false, next_change: None });
    }

    #[test]
    fn a_constant_schedule_never_changes() {
        let all = vec![true; WEEK_HOURS];
        assert_eq!(state_at(&plan(&all, None), 0, fixed).next_change, None);
        assert!(!state_at(&plan(&[], None), 0, fixed).on);
    }

    #[test]
    fn local_time_is_within_the_week() {
        assert!(local_hour_of_week(1_700_000_000) < WEEK_HOURS);
    }
}
