// Maps a ChannelFlow store mutation ("reason") to the bus messages it
// publishes. Pure (no DOM, no store import) so channels/tests/ can cover
// it under `node --test`; store.js calls it from _emit(). Topic meanings
// live in js/bus.js / docs/bus-topics.md.

import { TOPICS } from "../../js/bus.js";

/** Every reason store.js emits. */
export const SCHEDULER_REASONS = Object.freeze([
  "channel", "date", "select", "blocks", "media", "media-duration", "media-thumbnail",
  "drive-folder", "reels-autofill", "publish", "tick",
]);

const folder = (id, name) => (id ? { id, name: name || null } : null);

/** `s` is the store (or any object with the same fields). Returns
 *  `[{topic, data, state}]`; `state: true` messages go out through
 *  publishState() (retained, de-duplicated), the rest through publish(). */
export function schedulerNotifications(reason, s, { target = "local" } = {}) {
  const channel = () => {
    const ch = (s.channels || []).find((c) => c.id === s.activeChannelId);
    return { topic: TOPICS.SCHEDULER_CHANNEL_STATE, data: { channelId: s.activeChannelId, name: ch?.name ?? null }, state: true };
  };
  const date = () => ({ topic: TOPICS.SCHEDULER_DATE_STATE, data: { date: s.activeDate, isToday: !!s.isToday?.() }, state: true });
  const selection = () => ({ topic: TOPICS.SCHEDULER_SELECTION_STATE, data: { blockId: s.selectedBlockId ?? null }, state: true });
  const media = (kind) => ({ topic: TOPICS.SCHEDULER_MEDIA_CHANGED, data: { kind, count: (s.media || []).length } });

  switch (reason) {
    case "channel": return [channel(), selection()];
    case "date": return [date(), selection()];
    case "select": return [selection()];
    // A block edit can also clear the selection (removeBlock, a reloaded
    // schedule); publishState() drops the selection snapshot when unchanged.
    case "blocks": return [{ topic: TOPICS.SCHEDULER_BLOCKS_CHANGED, data: { channelId: s.activeChannelId, date: s.activeDate } }, selection()];
    case "media": return [media("list")];
    case "media-duration": return [media("duration")];
    case "media-thumbnail": return [media("thumbnail")];
    case "drive-folder":
      return [{
        topic: TOPICS.SCHEDULER_FOLDERS_STATE,
        data: { drive: folder(s.driveFolderId, s.driveFolderName), reels: folder(s.reelsFolderId, s.reelsFolderName) },
        state: true,
      }];
    case "reels-autofill": return [{ topic: TOPICS.SCHEDULER_AUTOFILL_STATE, data: { enabled: !!s.autoFillReels }, state: true }];
    case "publish": return [{ topic: TOPICS.SCHEDULER_SCHEDULE_PUBLISHED, data: { publishedAt: s.publishedAt ?? null, target } }];
    case "tick": return [{ topic: TOPICS.SCHEDULER_TICK, data: { now: s.nowSeconds ? s.nowSeconds() : null } }];
    default: throw new Error(`Unknown scheduler store reason: ${reason}`);
  }
}

/** The retained snapshots published once at startup so late subscribers
 *  can read current state from the bus. */
export function schedulerInitialState(s) {
  return ["channel", "date", "drive-folder", "reels-autofill"].flatMap((r) => schedulerNotifications(r, s));
}
