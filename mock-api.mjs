/**
 * Static demo backend for the Vercel build.
 *
 * The production page talks to the FastAPI host in `acgn_rag.web`; this repository has no Python
 * runtime, so the same four reads (`/snapshots`, `/retrieve`, `/ask`, plus the snapshot guard) are
 * answered from the fixed mock corpus the G2 demo uses. The shapes, status codes and refusal copy
 * mirror `src/acgn_rag/web/mock_port.py`, including the retired-snapshot 410 and the client-side
 * URL rule: nothing here invents fields the real host would not send.
 */

const CURRENT_SNAPSHOT_ID = "20261030-abcdef012345";
const RETAINED_SNAPSHOT_ID = "20261023-012345abcdef";
const RETIRED_SNAPSHOT_ID = "20261016-fedcba987654";
const PRIVATE_TERMS = ["电话", "住址", "未公开", "私人"];

const INVENTORY = { current: CURRENT_SNAPSHOT_ID, retained: [CURRENT_SNAPSHOT_ID, RETAINED_SNAPSHOT_ID] };

const RECORDS = [
  {
    chunk_id: "doc-90210::A::1",
    score: 0.93,
    quote:
      "电视动画《星海旅人》第二季确定于 2026 年 10 月 4 日开播。官方同时公开了首支预告片与主视觉图，制作阵容保持第一季原班人马。",
    media_ids: [90210],
    citation: {
      source_type: "official",
      publisher: "Aurora Animation",
      title: "第二季开播公告",
      url: "https://example.com/acgn-chronicle/mock/aurora/season-2",
      published_at: "2026-09-12",
      chunk_id: "doc-90210::A::1",
    },
  },
  {
    chunk_id: "doc-90210::A::2",
    score: 0.88,
    quote:
      "Anime News Network reports that Star Sea Traveler season two will premiere on 4 October 2026, with the original cast and studio returning.",
    media_ids: [90210],
    citation: {
      source_type: "media",
      publisher: "Anime News Network",
      title: "Star Sea Traveler season 2 premiere date",
      url: "https://example.com/acgn-chronicle/mock/ann/season-2",
      published_at: "2026-09-13",
      chunk_id: "doc-90210::A::2",
    },
  },
  {
    chunk_id: "doc-90210::A::3",
    score: 0.84,
    quote:
      "AniList lists Star Sea Traveler (media id 90210) as a TV series with 12 episodes, status upcoming, and an average score of 78.",
    media_ids: [90210],
    citation: {
      source_type: "metadata",
      publisher: "AniList",
      title: "Star Sea Traveler",
      url: "https://example.com/acgn-chronicle/mock/anilist/90210",
      published_at: "2026-09-01",
      chunk_id: "doc-90210::A::3",
    },
  },
  {
    chunk_id: "doc-90210::A::4",
    score: 0.79,
    quote:
      "Blu-ray 第一卷将于 2026 年 12 月 23 日发售，收录第 1 至 4 话；初回限定版附带设定集与原创广播剧 CD。",
    media_ids: [90210],
    citation: {
      source_type: "official",
      publisher: "Aurora Animation",
      title: "Blu-ray 发售公告",
      url: "https://example.com/acgn-chronicle/mock/aurora/blu-ray-1",
      published_at: "2026-09-20",
      chunk_id: "doc-90210::A::4",
    },
  },
  {
    chunk_id: "doc-77123::A::1",
    score: 0.71,
    quote:
      "《月灯食堂》剧场版定于 2027 年 1 月 15 日在日本上映，官方公开了特报影像与追加声优名单。",
    media_ids: [77123],
    citation: {
      source_type: "official",
      publisher: "Moonlight Diner Committee",
      title: "剧场版上映公告",
      url: "https://example.com/acgn-chronicle/mock/moonlight/movie",
      published_at: "2026-09-25",
      chunk_id: "doc-77123::A::1",
    },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(status, detail) {
  return json({ detail }, status);
}

function parseDate(value, endOfDay = false) {
  const text = String(value);
  const iso = text.length === 10 ? `${text}T00:00:00Z` : text.replace("Z", "+00:00");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return endOfDay && text.length === 10 ? new Date(date.getTime() + 24 * 60 * 60 * 1000) : date;
}

/**
 * Returns `[since, until]` in milliseconds, or a string describing why the filter is invalid.
 * A date-only `until` is widened to the next midnight, exactly like the Python host.
 */
function timeBounds(filters) {
  const sinceText = filters.since;
  const untilText = filters.until;
  const since = sinceText ? parseDate(sinceText) : null;
  if (sinceText && since === null) {
    return `Invalid ISO date or datetime: ${sinceText}`;
  }
  if (!untilText) {
    return [since, null];
  }
  const untilRaw = parseDate(untilText);
  if (untilRaw === null) {
    return `Invalid ISO date or datetime: ${untilText}`;
  }
  const until = parseDate(untilText, true);
  if (since) {
    // Two date-only bounds are compared as calendar dates *before* `until` widens to the next
    // midnight, so `since=2026-09-12, until=2026-09-12` stays a valid one-day window.
    const bothDateOnly = sinceText.length === 10 && untilText.length === 10;
    const upper = bothDateOnly ? untilRaw : until;
    if (since.getTime() > upper.getTime()) {
      return "`since` must not be later than `until`.";
    }
  }
  return [since, until];
}

function select({ text, top_k: topK = 5, filters = {} }) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const bounds = timeBounds(filters);
  if (typeof bounds === "string") {
    throw new Error(bounds);
  }
  const [since, until] = bounds;
  const sourceTypes = filters.source_types ?? [];
  const mediaIds = filters.media_ids ?? [];
  const chosen = RECORDS.filter((record) => {
    const citation = record.citation;
    if (sourceTypes.length > 0 && !sourceTypes.includes(citation.source_type)) {
      return false;
    }
    if (mediaIds.length > 0 && !mediaIds.some((id) => record.media_ids.includes(id))) {
      return false;
    }
    const published = parseDate(citation.published_at);
    if (since && published < since) {
      return false;
    }
    if (until && published >= until) {
      return false;
    }
    return true;
  });
  chosen.sort((left, right) =>
    right.score - left.score || left.chunk_id.localeCompare(right.chunk_id),
  );
  return chosen.slice(0, topK);
}

function abstain(reason) {
  return {
    answer: "当前快照中没有足够依据回答这个问题，因此不作答。",
    citations: [],
    cited_chunk_ids: [],
    abstained: true,
    abstain_reason: reason,
  };
}

function assertSnapshot(snapshotId) {
  if (!snapshotId || snapshotId === CURRENT_SNAPSHOT_ID || snapshotId === RETAINED_SNAPSHOT_ID) {
    return null;
  }
  if (snapshotId === RETIRED_SNAPSHOT_ID) {
    return fail(
      410,
      `Snapshot ${snapshotId} is retired; re-read /snapshots and start a new request.`,
    );
  }
  return fail(404, `Snapshot ${snapshotId} is not known to this host.`);
}

function handleRetrieve(body) {
  const snapshotError = assertSnapshot(body.snapshot_id);
  if (snapshotError) {
    return snapshotError;
  }
  let selected;
  try {
    selected = select(body);
  } catch (error) {
    return fail(422, error.message);
  }
  return json(selected);
}

function handleAsk(body) {
  const snapshotError = assertSnapshot(body.snapshot_id);
  if (snapshotError) {
    return snapshotError;
  }
  let selected;
  try {
    selected = select(body);
  } catch (error) {
    return fail(422, error.message);
  }
  const text = String(body.text ?? "").trim();
  if (!text) {
    return json(abstain("问题为空，没有可检索的文本。"));
  }
  if (selected.length === 0) {
    return json(abstain("当前筛选条件下没有可用证据；系统拒绝在没有依据时作答。"));
  }
  if (PRIVATE_TERMS.some((term) => text.includes(term))) {
    return json(abstain("问题涉及未公开的个人信息，知识库没有相关证据。"));
  }
  const seen = new Set();
  const citations = [];
  for (const record of selected) {
    if (seen.has(record.citation.chunk_id)) {
      continue;
    }
    seen.add(record.citation.chunk_id);
    citations.push(record.citation);
  }
  return json({
    answer:
      `（G1a 模拟回答）本次检索返回 ${selected.length} 条片段，最相关来源为 ` +
      `${selected[0].citation.publisher}（${selected[0].citation.source_type}）。` +
      "以下引用均来自本次检索结果；客户端只展示，不补全或改写原文。",
    citations,
    cited_chunk_ids: citations.map((citation) => citation.chunk_id),
    abstained: false,
    abstain_reason: null,
  });
}

const ROUTES = {
  "/snapshots": () => json(INVENTORY),
  "/retrieve": handleRetrieve,
  "/ask": handleAsk,
};

const realFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === "string" ? input : input.url;
  const url = new URL(rawUrl, window.location.href);
  const handler = ROUTES[url.pathname];
  if (!handler) {
    return realFetch(input, init);
  }
  let body = {};
  if (typeof init.body === "string" && init.body.length > 0) {
    try {
      body = JSON.parse(init.body);
    } catch {
      return fail(400, "Malformed request body.");
    }
  }
  // A short delay keeps loading states real instead of flashing past.
  await sleep(240);
  return handler(body);
};
