/* eslint-disable react/prop-types */
import { useNavigate, useSearchParams } from "react-router";

import { buildEmbeddedAppPath } from "../lib/embedded-route";
import styles from "../styles/home.module.css";

function formatStoredDate(dateString) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateString}T00:00:00Z`));
}

function formatHourLabel(hour) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(Date.UTC(2026, 0, 1, hour, 0, 0)));
}

export function SchedulerSection({ data }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const navigateEmbedded = (to) => navigate(buildEmbeddedAppPath(to, searchParams));

  return (
    <s-page heading="Delivery scheduler">
        <s-button slot="primary-action" onClick={() => navigateEmbedded("/app/schedule-rules")}>
          Edit schedule rules
        </s-button>

        <s-section>
          <div className={styles.statusStrip}>
            <div className={styles.stripPills}>
              <span className={`${styles.statusPill} ${styles.statusPillGood}`}>
                Shop-specific rules active
              </span>
              <span className={`${styles.statusPill} ${styles.statusPillGood}`}>
                Order counts syncing
              </span>
            </div>
            <div className={styles.stripDivider} />
            <div className={styles.stripStats}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Delivery slots</span>
                <span className={styles.statValue}>{data.metrics.slotCount}</span>
                <button
                  type="button"
                  className={styles.statAction}
                  onClick={() => navigateEmbedded("/app/schedule-rules#section-slots")}
                >
                  Edit slots
                </button>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Blocked dates</span>
                <span className={styles.statValue}>{data.metrics.blockedDateCount}</span>
                <button
                  type="button"
                  className={styles.statAction}
                  onClick={() => navigateEmbedded("/app/schedule-rules#section-blocked-dates")}
                >
                  Manage
                </button>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Capacity days</span>
                <span className={styles.statValue}>{data.metrics.trackedCapacityDayCount}</span>
                {(data.metrics.fullCount > 0 || data.metrics.nearLimitCount > 0) && (
                  <span className={styles.statAlert}>
                    {data.metrics.fullCount} full · {data.metrics.nearLimitCount} filling fast
                  </span>
                )}
                <button
                  type="button"
                  className={styles.statAction}
                  onClick={() =>
                    navigateEmbedded("/app/schedule-rules#section-slot-capacities")
                  }
                >
                  Manage
                </button>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Slot blocks</span>
                <span className={styles.statValue}>{data.metrics.blockedSlotCount}</span>
                <button
                  type="button"
                  className={styles.statAction}
                  onClick={() => navigateEmbedded("/app/schedule-rules#section-blocked-slots")}
                >
                  Manage
                </button>
              </div>
            </div>
          </div>
        </s-section>

        <s-section heading="Operations">
          <div className={styles.opsGrid}>
            <div className={styles.opsLeft}>
              <div className={styles.opsColHeader}>
                <h3 className={styles.opsColTitle}>Capacity watchlist</h3>
                <p className={styles.opsColDesc}>Booked counts sync from live orders.</p>
              </div>
              {data.watchlist.length ? (
                <div className={styles.watchStack}>
                  {data.watchlist.map((entry) => (
                    <article key={`${entry.date}-${entry.slotValue}`} className={styles.watchCard}>
                      <div className={styles.watchHeader}>
                        <div>
                          <p className={styles.watchDate}>{formatStoredDate(entry.date)}</p>
                          <h3 className={styles.watchTitle}>{entry.slotLabel}</h3>
                        </div>
                        <span
                          className={`${styles.watchBadge} ${
                            entry.status.tone === "critical"
                              ? styles.watchBadgeCritical
                              : entry.status.tone === "warning"
                                ? styles.watchBadgeWarning
                                : entry.status.tone === "neutral"
                                  ? styles.watchBadgeNeutral
                                  : styles.watchBadgeGood
                          }`}
                        >
                          {entry.status.label}
                        </span>
                      </div>
                      <p className={styles.watchMeta}>
                        {entry.booked} booked of {entry.capacity} capacity
                        {entry.capacity > 0 ? ` · ${entry.remaining} remaining` : ""}
                      </p>
                      <div className={styles.progressTrack}>
                        <div
                          className={`${styles.progressBar} ${
                            entry.status.tone === "critical"
                              ? styles.progressBarCritical
                              : entry.status.tone === "warning"
                                ? styles.progressBarWarning
                                : entry.status.tone === "neutral"
                                  ? styles.progressBarNeutral
                                  : styles.progressBarGood
                          }`}
                          style={{
                            width: `${Math.max(
                              entry.utilizationPercent,
                              entry.capacity > 0 ? 8 : 100,
                            )}%`,
                          }}
                        />
                      </div>
                      <div className={styles.watchCardFooter}>
                        <button
                          type="button"
                          className={styles.quickAction}
                          onClick={() =>
                            navigateEmbedded("/app/schedule-rules#section-slot-capacities")
                          }
                        >
                          Edit capacity
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className={styles.emptyState}>
                  No capacity entries configured. Add per-date slot capacities in Schedule rules
                  to track demand before dates fill.
                </p>
              )}
            </div>

            <div className={styles.opsRight}>
              <section className={styles.panelCard}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitleRow}>
                    <h3 className={styles.panelTitle}>Full-day blocks</h3>
                    <button
                      type="button"
                      className={styles.quickAction}
                      onClick={() =>
                        navigateEmbedded("/app/schedule-rules#section-blocked-dates")
                      }
                    >
                      Edit
                    </button>
                  </div>
                  <p className={styles.panelDescription}>
                    Dates where every delivery slot is unavailable.
                  </p>
                </div>
                {data.upcomingBlockedDates.length ? (
                  <div className={styles.listStack}>
                    {data.upcomingBlockedDates.map((date) => (
                      <div key={date} className={styles.listRow}>
                        <span className={styles.listPrimary}>{formatStoredDate(date)}</span>
                        <span className={styles.listSecondary}>All slots blocked</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.emptyState}>No upcoming full-day blocks.</p>
                )}
              </section>

              <section className={styles.panelCard}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitleRow}>
                    <h3 className={styles.panelTitle}>Selective slot blocks</h3>
                    <button
                      type="button"
                      className={styles.quickAction}
                      onClick={() =>
                        navigateEmbedded("/app/schedule-rules#section-blocked-slots")
                      }
                    >
                      Edit
                    </button>
                  </div>
                  <p className={styles.panelDescription}>
                    Dates where only specific windows are closed.
                  </p>
                </div>
                {data.blockedSlotDates.length ? (
                  <div className={styles.listStack}>
                    {data.blockedSlotDates.map((entry) => (
                      <div key={entry.date} className={styles.listRowBlock}>
                        <div>
                          <p className={styles.listPrimary}>{formatStoredDate(entry.date)}</p>
                          <p className={styles.listSecondary}>
                            {entry.slotCount} blocked slot{entry.slotCount === 1 ? "" : "s"}
                          </p>
                        </div>
                        <p className={styles.slotLine}>{entry.slots.join(" · ")}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.emptyState}>No selective slot blocks configured.</p>
                )}
              </section>
            </div>
          </div>
        </s-section>

        <s-section slot="aside" heading="Scheduler defaults">
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Shop</dt>
              <dd className={styles.detailValue}>{data.shop}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Timezone</dt>
              <dd className={styles.detailValue}>{data.rules.timezone}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Cutoff hour</dt>
              <dd className={styles.detailValue}>{formatHourLabel(data.rules.cutoffHour)}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Prep time</dt>
              <dd className={styles.detailValue}>{data.rules.prepHours} hr</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Booking window</dt>
              <dd className={styles.detailValue}>{data.rules.maxDays} days</dd>
            </div>
          </dl>
          <button
            type="button"
            className={styles.quickAction}
            onClick={() => navigateEmbedded("/app/schedule-rules#section-defaults")}
          >
            Edit defaults
          </button>
        </s-section>

        <s-section slot="aside" heading="Active delivery slots">
          <div className={styles.slotPillGroup}>
            {data.rules.slots.map((slot) => (
              <span key={slot.value} className={styles.slotPill}>
                {slot.display}
              </span>
            ))}
          </div>
        </s-section>

        <s-section slot="aside" heading="Protected rush rules">
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Dates</dt>
              <dd className={styles.detailValue}>
                {data.protectedRushDates.map(formatStoredDate).join(" - ")}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>Slots</dt>
              <dd className={styles.detailValue}>
                {data.protectedRushSlots.map((slot) => slot.display).join(", ")}
              </dd>
            </div>
          </dl>
        </s-section>
      </s-page>
  );
}
