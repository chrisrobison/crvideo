// Shared deterministic fixture for Explorer's tests: a 2-hour published window with
// two program occurrences (P1: continuity lead-in, ep-a, ep-b, continuity filler;
// P2: ep-a alone) followed by an uncovered gap.
import * as M from "../../scheduler/js/components/explorer/explorer-model.js";

export const A = Date.parse("2026-01-05T00:00:00Z") / 1000;

const video = (id, start, duration, program_id) => ({ type: "video", id, start, duration, title: id.toUpperCase(), media_url: null, source: { provider: "youtube", video_id: id, url: `https://y/${id}` }, program_id });
export function fixture({ window = true } = {}) {
  const schedule = {
    ...(window ? { _publish: { generated_at: "x", window: { start: new Date(A * 1000).toISOString(), end: new Date((A + 7200) * 1000).toISOString() }, episode_sets: [{ block_id: "b1", series_id: "demo", version: 1, episode_count: 2 }] } } : {}),
    schema_version: 1, channel: "Demo",
    blocks: [{
      block: 1, type: "normal", duration: 7200, used: 3600, remaining: 3600, relative_start: 0,
      items: [
        { type: "continuity", id: "continuity-lead", start: 0, duration: 10, template: "up-next", next_program_id: "ep-a", program_id: "P1" },
        video("ep-a", 10, 900, "P1"),
        video("ep-b", 910, 600, "P1"),
        { type: "continuity", id: "continuity-fill", start: 1510, duration: 290, template: "up-next", next_program_id: "ep-a", program_id: "P1" },
        video("ep-a", 1800, 900, "P2"),
      ],
    }],
    programs: [
      { occurrence_id: "P1", block_id: "b1", title: "Demo Hour", series_id: "demo", series_title: "Demo", boundary_mode: "hard", nominal_start: 0, nominal_end: 1800, start: 0, end: 1800 },
      { occurrence_id: "P2", block_id: "b1", title: "Demo Hour", series_id: "demo", series_title: "Demo", boundary_mode: "hard", nominal_start: 1800, nominal_end: 3600, start: 1800, end: 3600 },
    ],
  };
  return M.buildScheduleView({ id: "demo-channel", meta: { anchor: new Date(A * 1000).toISOString() }, schedule });
}

