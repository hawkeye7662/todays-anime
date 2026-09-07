import fetch from 'node-fetch'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID
const NOTIFICATION_MODE = process.env.NOTIFICATION_MODE ?? 'summary'
const IGNORE_RELEASE_CACHE = process.env.IGNORE_RELEASE_CACHE === 'true'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY
const SUBSPLEASE_RSS_URL = 'https://subsplease.org/rss/?t&r=1080'
const RELEASE_STATE_FILE =
  process.env.RELEASE_STATE_FILE ?? '.cache/todays-anime/releases.json'
const RELEASE_STATE_RETENTION_SECONDS = 14 * 24 * 60 * 60
const EPISODE_NUMBER_FALLBACK_WINDOW_SECONDS = 6 * 60 * 60
const SETTINGS_TABLE = 'discord_notification_settings'
const MAL_SCHEDULE_FALLBACK_URL = 'https://today.hzwk.workers.dev/'

const DEFAULT_USERS = {
  // maxSummaryPingBehindEpisodes and maxReleasePingBehindEpisodes control how far behind a watcher can be
  // and still get pinged for the morning summary or release alerts. null means always ping.
  Fried_Saanto: {
    discordId: '478945648906076160',
    pingSummary: true,
    pingRelease: false,
    maxSummaryPingBehindEpisodes: 2,
    maxReleasePingBehindEpisodes: null,
  },
  HawkEye7662: {
    discordId: '293712947623100416',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  Asteriful: {
    discordId: '685632451707535394',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  Keppix: {
    discordId: '533342860339183646',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  Ullas_22: {
    discordId: '839559160071979089',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  MiniJCm: {
    discordId: '791195889775411200',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  SpiralEnjoyAnime: {
    discordId: '707975063835639949',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  Ansmol: {
    discordId: '836253616532226149',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  ThunderCam777: {
    discordId: '293101052675358721',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  c4sian16: {
    discordId: '411153226835034122',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  elephantoChan: {
    discordId: '606080832750485527',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
  EllesHere: {
    discordId: '264913847347838996',
    pingSummary: true,
    pingRelease: true,
    maxSummaryPingBehindEpisodes: null,
    maxReleasePingBehindEpisodes: null,
  },
}

let USERS = structuredClone(DEFAULT_USERS)

async function fetchRemoteUserSettings() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return []
  }

  const url =
    `${SUPABASE_URL}/rest/v1/${SETTINGS_TABLE}` +
    '?select=discord_id,mal_username,display_name,ping_summary,ping_release,max_summary_ping_behind_episodes,max_release_ping_behind_episodes'

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
  })
  assertOk(res, 'Failed to fetch remote user settings')

  return res.json()
}

function applyRemoteUserSettings(settingsRows) {
  if (!Array.isArray(settingsRows) || !settingsRows.length) {
    return
  }

  const remoteUsers = {}
  for (const row of settingsRows) {
    const malUsername = row.mal_username
    if (!malUsername || !row.discord_id) {
      continue
    }

    remoteUsers[malUsername] = {
      discordId: row.discord_id,
      displayName: row.display_name ?? malUsername,
      pingSummary: row.ping_summary ?? true,
      pingRelease: row.ping_release ?? true,
      maxSummaryPingBehindEpisodes:
        row.max_summary_ping_behind_episodes == null
          ? null
          : row.max_summary_ping_behind_episodes,
      maxReleasePingBehindEpisodes:
        row.max_release_ping_behind_episodes == null
          ? null
          : row.max_release_ping_behind_episodes,
    }
  }

  USERS = Object.keys(remoteUsers).length ? remoteUsers : structuredClone(DEFAULT_USERS)
}

// ─── AniList ──────────────────────────────────────────────────────────────────

const ANILIST_URL = 'https://graphql.anilist.co'

const AIRING_QUERY = `
  query AiringToday($start: Int!, $end: Int!, $page: Int!) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $start, airingAt_lesser: $end) {
        airingAt
        episode
        media {
          id
          idMal
          title { english romaji }
          synonyms
          episodes
          source
          genres
          bannerImage
          coverImage { large color }
          studios { nodes { name } }
          trailer { id site }
        }
      }
    }
  }
`

const SUBSPLEASE_ITEM_REGEX = /<item>([\s\S]*?)<\/item>/g
const RSS_FIELD_REGEXES = {
  title: /<title>([\s\S]*?)<\/title>/i,
  link: /<link>([\s\S]*?)<\/link>/i,
  pubDate: /<pubDate>([\s\S]*?)<\/pubDate>/i,
}
const SUBSPLEASE_EPISODE_REGEX =
  /^\[SubsPlease\]\s+(.+?)\s+-\s+(\d{1,3})(?:v\d+)?\s+\(/i
const SUBSPLEASE_EXCLUDED_TITLE_REGEX =
  /\b(batch|preview|pv|ova|ona|special)\b/i

function assertOk(response, message) {
  if (!response.ok) {
    throw new Error(`${message}: ${response.status} ${response.statusText}`)
  }
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function extractXmlField(xml, field) {
  const match = RSS_FIELD_REGEXES[field].exec(xml)
  return match ? decodeHtmlEntities(match[1].trim()) : null
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/\b(?:season|part|cour)\s+\d+\b/g, ' ')
    .replace(/\bs\d+\b/g, ' ')
    .replace(/\b(?:ii|iii|iv|v|vi)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitTitleWords(title) {
  return normalizeTitle(title)
    .split(' ')
    .filter((word) => word.length > 1)
}

function overlapCount(candidateWords, releaseWordSet) {
  return candidateWords.filter((word) => releaseWordSet.has(word)).length
}

function titleMatches(candidateTitle, releaseTitle) {
  const candidateWords = splitTitleWords(candidateTitle)
  const releaseWords = splitTitleWords(releaseTitle)

  if (!candidateWords.length || !releaseWords.length) {
    return false
  }

  const releaseWordSet = new Set(releaseWords)
  const candidateWordSet = new Set(candidateWords)
  const overlap = overlapCount(candidateWords, releaseWordSet)

  if (candidateWords.every((word) => releaseWordSet.has(word))) {
    return true
  }

  if (
    releaseWords.length >= 3 &&
    releaseWords.every((word) => candidateWordSet.has(word))
  ) {
    return true
  }

  if (candidateWords.length === 1) {
    return candidateWords[0] === releaseWords[0]
  }

  return overlap >= 2 && overlap / candidateWords.length >= 0.6
}

function buildTitleCandidates(anime) {
  const rawTitles = [
    anime.titleEnglish,
    anime.titleRomaji,
    ...(anime.synonyms ?? []),
  ].filter(Boolean)

  const candidates = new Set()

  for (const title of rawTitles) {
    candidates.add(title)

    const colonTitle = title.split(':')[0]?.trim()
    if (colonTitle && colonTitle !== title) {
      candidates.add(colonTitle)
    }

    const spacedDashTitle = title.split(' - ')[0]?.trim()
    if (spacedDashTitle && spacedDashTitle !== title) {
      candidates.add(spacedDashTitle)
    }
  }

  return [...candidates].sort(
    (a, b) => splitTitleWords(b).length - splitTitleWords(a).length,
  )
}

function parseSubsPleaseFeed(xml) {
  const releases = []

  for (const item of xml.matchAll(SUBSPLEASE_ITEM_REGEX)) {
    const itemXml = item[1]
    const title = extractXmlField(itemXml, 'title')
    const link = extractXmlField(itemXml, 'link')
    const pubDate = extractXmlField(itemXml, 'pubDate')

    if (
      !title ||
      !link ||
      !pubDate ||
      SUBSPLEASE_EXCLUDED_TITLE_REGEX.test(title)
    ) {
      continue
    }

    const match = SUBSPLEASE_EPISODE_REGEX.exec(title)
    if (!match) {
      continue
    }

    const releasedAt = Date.parse(pubDate)
    if (Number.isNaN(releasedAt)) {
      continue
    }

    releases.push({
      releaseTitle: match[1].trim(),
      episode: Number(match[2]),
      link,
      releasedAt: Math.floor(releasedAt / 1000),
    })
  }

  return releases
}

async function fetchRecentSubsPleaseReleases() {
  const res = await fetch(SUBSPLEASE_RSS_URL)
  assertOk(res, 'Failed to fetch SubsPlease RSS feed')

  return parseSubsPleaseFeed(await res.text())
}

function getRelevantAnime(airingToday, watchlistMap) {
  const relevant = airingToday
    .filter((anime) => anime.malId && watchlistMap.has(anime.malId))
    .sort((a, b) => a.airingAt - b.airingAt)

  const watching = relevant.filter(
    (anime) => watchlistMap.get(anime.malId).watchers.length > 0,
  )
  const ptw = relevant.filter(
    (anime) =>
      anime.episode === 1 && watchlistMap.get(anime.malId).ptwers.length > 0,
  )

  return { relevant, watching, ptw }
}

function findMatchingRelease(anime, releases, nowTimestamp) {
  const candidates = buildTitleCandidates(anime)

  for (const candidate of candidates) {
    const match = releases.find(
      (release) =>
        release.episode === anime.episode &&
        titleMatches(candidate, release.releaseTitle),
    )

    if (match) {
      return match
    }
  }

  const episodeNumberFallbacks = releases.filter(
    (release) =>
      release.releasedAt <= nowTimestamp &&
      release.releasedAt >=
        anime.airingAt - EPISODE_NUMBER_FALLBACK_WINDOW_SECONDS &&
      candidates.some((candidate) =>
        titleMatches(candidate, release.releaseTitle),
      ),
  )

  return episodeNumberFallbacks.length === 1 ? episodeNumberFallbacks[0] : null
}

function attachReleaseInfo(animeList, releases, nowTimestamp) {
  return animeList
    .map((anime) => {
      const release = findMatchingRelease(anime, releases, nowTimestamp)
      return release ? { ...anime, release } : null
    })
    .filter(Boolean)
}

function getReleaseKey(anime) {
  return `${anime.malId}:${anime.episode}:${anime.release.releasedAt}`
}

function getAiringKey(anime) {
  return `${anime.malId}:${anime.episode}`
}

function groupAnimeAudiences(watching, ptw, watchlistMap) {
  const groups = new Map()

  function addAudience(anime, audienceKey) {
    const key = getAiringKey(anime)
    const watchlistEntry = watchlistMap.get(anime.malId)

    if (!groups.has(key)) {
      groups.set(key, { anime, watchers: [], ptwers: [] })
    }

    groups.get(key)[audienceKey] = watchlistEntry?.[audienceKey]
      ? [...watchlistEntry[audienceKey]]
      : []
  }

  watching.forEach((anime) => addAudience(anime, 'watchers'))
  ptw.forEach((anime) => addAudience(anime, 'ptwers'))

  return [...groups.values()].sort((a, b) => a.anime.airingAt - b.anime.airingAt)
}

function pruneReleaseState(state, nowTimestamp) {
  const cutoff = nowTimestamp - RELEASE_STATE_RETENTION_SECONDS

  return {
    notifiedReleases: state.notifiedReleases.filter(
      (entry) => entry.releasedAt >= cutoff,
    ),
  }
}

async function loadReleaseState(nowTimestamp) {
  try {
    const raw = await readFile(RELEASE_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const notifiedReleases = Array.isArray(parsed.notifiedReleases)
      ? parsed.notifiedReleases.filter(
          (entry) =>
            entry &&
            typeof entry.key === 'string' &&
            Number.isFinite(entry.releasedAt),
        )
      : []

    return pruneReleaseState({ notifiedReleases }, nowTimestamp)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { notifiedReleases: [] }
    }

    throw error
  }
}

async function saveReleaseState(state, nowTimestamp) {
  const prunedState = pruneReleaseState(state, nowTimestamp)
  await mkdir(dirname(RELEASE_STATE_FILE), { recursive: true })
  await writeFile(RELEASE_STATE_FILE, JSON.stringify(prunedState, null, 2))
}

function extendReleaseState(state, animeList) {
  const notifiedReleases = [...state.notifiedReleases]

  for (const anime of animeList) {
    notifiedReleases.push({
      key: getReleaseKey(anime),
      releasedAt: anime.release.releasedAt,
    })
  }

  return { notifiedReleases }
}

function chunkArray(items, chunkSize) {
  const chunks = []

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }

  return chunks
}

function toDiscordColor(color) {
  if (!color?.startsWith('#')) {
    return null
  }

  return Number.parseInt(color.slice(1), 16)
}

function shouldPingUser(username, mode) {
  const user = USERS[username]

  if (!user?.discordId) {
    return false
  }

  if (mode === 'summary' && typeof user.pingSummary === 'boolean') {
    return user.pingSummary
  }

  if (mode === 'release' && typeof user.pingRelease === 'boolean') {
    return user.pingRelease
  }

  if (typeof user.ping === 'boolean') {
    return user.ping
  }

  return false
}

function getViewerLabels(usernames, mode) {
  return usernames.map((username) => {
    const { discordId, displayName } = USERS[username]
    return shouldPingUser(username, mode) && discordId
      ? `<@${discordId}>`
      : displayName || username
  })
}

function getPingMentions(usernames, mode) {
  return usernames.flatMap((username) => {
    const { discordId } = USERS[username]
    return shouldPingUser(username, mode) && discordId
      ? [`<@${discordId}>`]
      : []
  })
}

function shouldPingSummaryMention(anime, username, watchlistMap) {
  if (!shouldPingUser(username, 'summary')) {
    return false
  }

  const threshold = USERS[username]?.maxSummaryPingBehindEpisodes
  if (threshold == null) {
    return true
  }

  const watchedEpisodes = watchlistMap.get(anime.malId)?.watcherProgress?.[
    username
  ]

  return getBehindCount(watchedEpisodes, anime.episode) <= threshold
}

function getSummaryViewerLabels(anime, usernames, watchlistMap) {
  return usernames.map((username) => {
    const { discordId, displayName } = USERS[username]
    return shouldPingSummaryMention(anime, username, watchlistMap) && discordId
      ? `<@${discordId}>`
      : displayName || username
  })
}

function shouldPingReleaseMention(anime, username, watchlistMap) {
  if (!shouldPingUser(username, 'release')) {
    return false
  }

  const threshold = USERS[username]?.maxReleasePingBehindEpisodes
  if (threshold == null) {
    return true
  }

  const watchedEpisodes = watchlistMap.get(anime.malId)?.watcherProgress?.[
    username
  ]

  return getBehindCount(watchedEpisodes, anime.episode) <= threshold
}

function getReleasePingMentions(anime, usernames, watchlistMap) {
  return usernames.flatMap((username) => {
    const { discordId } = USERS[username]
    return shouldPingReleaseMention(anime, username, watchlistMap) && discordId
      ? [`<@${discordId}>`]
      : []
  })
}

function getReleaseEmbedViewerLabel(username) {
  const { discordId, displayName } = USERS[username]
  return discordId ? `<@${discordId}>` : displayName || username
}

function getMalUpdateLink(malId) {
  return `https://myanimelist.net/ownlist/anime/${malId}/edit?hideLayout=0`
}

function getMalAnimeLink(malId) {
  return `https://myanimelist.net/anime/${malId}`
}

function isFinale(anime) {
  return (
    Number.isFinite(anime.totalEpisodes) &&
    anime.totalEpisodes > 0 &&
    anime.episode === anime.totalEpisodes
  )
}

function getFinaleLabel(anime) {
  return isFinale(anime) ? 'Finale' : null
}

function getTrailerUrl(trailer) {
  if (!trailer?.id || !trailer?.site) {
    return null
  }

  if (trailer.site.toLowerCase() === 'youtube') {
    return `https://www.youtube.com/watch?v=${trailer.id}`
  }

  return null
}

function getReleaseDescription(sectionTitle, releasedAt) {
  return [sectionTitle, `Released: <t:${releasedAt}:R>`].join('\n')
}

function formatEnumLabel(value) {
  if (!value) {
    return null
  }

  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatEpisodeCount(anime) {
  if (!Number.isFinite(anime.totalEpisodes) || anime.totalEpisodes <= 0) {
    return null
  }

  return `${anime.totalEpisodes} episode${anime.totalEpisodes === 1 ? '' : 's'}`
}

function formatSummaryHeading(anime, prefix) {
  const suffix = getFinaleLabel(anime) ? ' — Finale' : ''
  return `${prefix} ${anime.title}${suffix}`
}

function formatWatchingSummaryHeading(anime) {
  const suffix = getFinaleLabel(anime) ? ' — Finale' : ''
  const episode = Number.isFinite(anime.episode)
    ? ` (ep. ${anime.episode})`
    : ''
  return `## ${anime.title}${episode}${suffix}`
}

function getReleaseSectionTitle(group) {
  const { anime, watchers, ptwers } = group

  if (watchers.length && ptwers.length && anime.episode === 1) {
    return isFinale(anime) ? 'Premiere out now • Finale' : 'Premiere out now'
  }

  if (watchers.length) {
    return isFinale(anime) ? 'Episode out now • Finale' : 'Episode out now'
  }

  return isFinale(anime)
    ? 'Plan to watch premiere out now • Finale'
    : 'Plan to watch premiere out now'
}

function getReleaseMetadataFields(anime) {
  const studios = anime.studios?.length ? anime.studios.slice(0, 3).join(', ') : null
  const source = formatEnumLabel(anime.source)
  const episodeCount = formatEpisodeCount(anime)
  const genres = anime.genres?.length ? anime.genres.slice(0, 3).join(', ') : null

  return [
    {
      name: 'Details',
      value: [
        studios ? `**Studio:** ${studios}` : null,
        source ? `**Source:** ${source}` : null,
        episodeCount ? `**Episodes:** ${episodeCount}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    genres ? { name: 'Genres', value: genres } : null,
  ].filter((field) => field?.value)
}

function formatBehindIndicator(watchedEpisodes, currentEpisode) {
  if (!Number.isFinite(watchedEpisodes)) {
    return null
  }

  const behindCount = getBehindCount(watchedEpisodes, currentEpisode)
  if (behindCount <= 0) {
    return null
  }

  return `${behindCount} episode${behindCount === 1 ? '' : 's'} behind`
}

function getBehindCount(watchedEpisodes, currentEpisode) {
  if (!Number.isFinite(watchedEpisodes)) {
    return 0
  }

  return Math.max(0, currentEpisode - 1 - watchedEpisodes)
}

function formatWatchingViewerLines(anime, usernames, watchlistMap) {
  const { watcherProgress } = watchlistMap.get(anime.malId)

  return usernames.map((username) => {
    const viewer = getReleaseEmbedViewerLabel(username)
    const behindIndicator = formatBehindIndicator(
      watcherProgress[username],
      anime.episode,
    )

    return behindIndicator ? `${viewer} — ${behindIndicator}` : viewer
  })
}

function formatPtwViewerLines(anime, usernames, watchlistMap) {
  return watchlistMap
    .get(anime.malId)
    .ptwers.map((username) => getReleaseEmbedViewerLabel(username))
}

function withReleaseFields(entry, fields) {
  return {
    ...entry,
    embed: {
      ...entry.embed,
      fields,
    },
  }
}

function getTrailerButton(anime) {
  if (anime.episode !== 1) {
    return null
  }

  const trailerUrl = getTrailerUrl(anime.trailer)
  if (!trailerUrl) {
    return null
  }

  return {
    type: 2,
    style: 5,
    label: `${anime.title.slice(0, 68)} PV`,
    url: trailerUrl,
  }
}

function buildActionRows(buttons) {
  return chunkArray(buttons, 5).map((rowButtons) => ({
    type: 1,
    components: rowButtons,
  }))
}

async function fetchTodaysAiring(now = new Date(), request = fetch) {
  const startOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const endOfDay = startOfDay + 86400000 // +24h in ms

  const start = Math.floor(startOfDay / 1000)
  const end = Math.floor(endOfDay / 1000)

  try {
    return await fetchAniListAiring(start, end, request)
  } catch (anilistError) {
    console.warn(
      `AniList airing schedule failed; falling back to MAL schedule: ${anilistError.message}`,
    )

    try {
      return await fetchMalScheduleFallback(request)
    } catch (malError) {
      throw new AggregateError(
        [anilistError, malError],
        'Failed to fetch airing schedule from AniList and MAL fallback',
      )
    }
  }
}

async function fetchAniListAiring(start, end, request = fetch) {
  const results = []
  let page = 1

  while (true) {
    const res = await request(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: AIRING_QUERY,
        variables: { start, end, page },
      }),
    })
    assertOk(res, 'Failed to fetch AniList airing schedule')

    const { data, errors } = await res.json()
    if (errors?.length) {
      throw new Error(`AniList query failed: ${errors[0].message}`)
    }

    const { airingSchedules, pageInfo } = data.Page

    for (const entry of airingSchedules) {
      results.push({
        anilistId: entry.media.id,
        malId: entry.media.idMal,
        title: entry.media.title.english || entry.media.title.romaji,
        titleEnglish: entry.media.title.english,
        titleRomaji: entry.media.title.romaji,
        synonyms: entry.media.synonyms,
        totalEpisodes: entry.media.episodes,
        source: entry.media.source,
        genres: entry.media.genres,
        bannerImage: entry.media.bannerImage,
        coverImage: entry.media.coverImage.large,
        coverImageColor: entry.media.coverImage.color,
        studios: entry.media.studios.nodes.map((studio) => studio.name),
        trailer: entry.media.trailer,
        episode: entry.episode,
        airingAt: entry.airingAt,
      })
    }

    if (!pageInfo.hasNextPage) break
    page++
  }

  return results
}

async function fetchMalScheduleFallback(request = fetch) {
  const res = await request(MAL_SCHEDULE_FALLBACK_URL)
  assertOk(res, 'Failed to fetch MAL fallback airing schedule')

  const data = await res.json()
  if (!Array.isArray(data?.today)) {
    throw new Error('MAL fallback returned an invalid airing schedule')
  }

  return data.today
    .filter(
      (entry) =>
        Number.isInteger(entry?.id) &&
        typeof entry.title === 'string' &&
        entry.title &&
        Number.isFinite(entry.unix),
    )
    .map((entry) => ({
      anilistId: null,
      malId: entry.id,
      title: entry.title,
      titleEnglish: entry.title,
      titleRomaji: null,
      synonyms: [],
      totalEpisodes: null,
      source: null,
      genres: [],
      bannerImage: null,
      coverImage: null,
      coverImageColor: null,
      studios: [],
      trailer: null,
      // The Worker supplies the next air time but not its episode number.
      episode: null,
      airingAt: entry.unix,
    }))
}

// ─── MAL user watchlists ──────────────────────────────────────────────────────

const MAL_API = 'https://api.myanimelist.net/v2/users'

async function fetchAllUserWatchlists() {
  // Returns a Map<malId, { watchers: string[], ptwers: string[] }>
  const map = new Map()

  for (const username of Object.keys(USERS)) {
    for (const status of ['watching', 'plan_to_watch']) {
      let url = `${MAL_API}/${username}/animelist?status=${status}&limit=100&nsfw=true&fields=list_status`

      while (url) {
        const res = await fetch(url, {
          headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
        })
        assertOk(res, `Failed to fetch MAL list for ${username} (${status})`)
        const data = await res.json()
        for (const { node, list_status: listStatus } of data.data) {
          if (!map.has(node.id)) {
            map.set(node.id, { watchers: [], ptwers: [], watcherProgress: {} })
          }
          if (status === 'watching') {
            map.get(node.id).watchers.push(username)
            map.get(node.id).watcherProgress[username] =
              listStatus?.num_episodes_watched ?? 0
          } else {
            map.get(node.id).ptwers.push(username)
          }
        }
        url = data.paging?.next ?? null
      }
    }
  }

  return map
}

// ─── Format & send ────────────────────────────────────────────────────────────

function formatSummaryMessage(groups, watchlistMap) {
  if (!groups.length) {
    return "# Today's Anime\nNo anime airing today 😔"
  }

  const lines = ["# Today's Anime"]
  const watchingGroups = groups.filter((group) => group.watchers.length)
  const ptwOnlyGroups = groups.filter(
    (group) => !group.watchers.length && group.ptwers.length,
  )

  for (const group of watchingGroups) {
    const { anime, watchers, ptwers } = group
    const viewers = getSummaryViewerLabels(
      anime,
      watchers,
      watchlistMap,
    )
    lines.push(formatWatchingSummaryHeading(anime))
    lines.push(`Viewers: ${viewers.join(', ')}`)
    if (ptwers.length) {
      lines.push(`Plan to Watch: ${getViewerLabels(ptwers, 'summary').join(', ')}`)
    }
    lines.push(`Time: <t:${anime.airingAt}>`)
  }

  if (ptwOnlyGroups.length) {
    lines.push(`\n## 📋 Plan to Watch`)

    for (const group of ptwOnlyGroups) {
      const { anime, ptwers } = group
      const viewers = getViewerLabels(ptwers, 'summary')
      lines.push(formatSummaryHeading(anime, '###'))
      lines.push(`Viewers: ${viewers.join(', ')}`)
      lines.push(`Time: <t:${anime.airingAt}>`)
    }
  }

  return lines.join('\n')
}

function createReleaseEntry(group, watchlistMap) {
  const { anime, watchers, ptwers } = group
  const isPremiere = anime.episode === 1

  return {
    mentions: [
      ...getReleasePingMentions(anime, watchers, watchlistMap),
      ...getReleasePingMentions(anime, ptwers, watchlistMap),
    ],
    trailerButton: isPremiere ? getTrailerButton(anime) : null,
    embed: {
      title: isPremiere
        ? `${anime.title} (ep. ${anime.episode})${isFinale(anime) ? ' — Finale' : ''}`
        : anime.title,
      url: getMalAnimeLink(anime.malId),
      ...(isPremiere
        ? {
            description: getReleaseDescription(
              getReleaseSectionTitle(group),
              anime.release.releasedAt,
            ),
            image: anime.bannerImage ? { url: anime.bannerImage } : undefined,
            timestamp: new Date(anime.release.releasedAt * 1000).toISOString(),
          }
        : {}),
      color: toDiscordColor(anime.coverImageColor) ?? 0x5865f2,
      thumbnail: anime.coverImage ? { url: anime.coverImage } : undefined,
    },
  }
}

function createReleasePayloads(groups, watchlistMap) {
  const entries = groups.map((group) => {
    const { anime, watchers, ptwers } = group

    return withReleaseFields(
      createReleaseEntry(group, watchlistMap),
      [
        watchers.length
          ? {
              name: 'Viewers',
              value: formatWatchingViewerLines(anime, watchers, watchlistMap).join(
                '\n',
              ),
            }
          : null,
        ptwers.length
          ? {
              name: watchers.length ? 'Plan to Watch' : 'Viewers',
              value: formatPtwViewerLines(anime, ptwers, watchlistMap).join('\n'),
            }
          : null,
        ...(anime.episode === 1
          ? [
              {
                name: 'MAL',
                value: `[Update your list](${getMalUpdateLink(anime.malId)})`,
              },
              ...getReleaseMetadataFields(anime),
            ]
          : []),
      ].filter(Boolean),
    )
  })

  if (!entries.length) {
    return []
  }

  return chunkArray(entries, 10).map((chunk) => {
    const trailerButtons = chunk.flatMap((entry) =>
      entry.trailerButton ? [entry.trailerButton] : [],
    )

    return {
      content: [...new Set(chunk.flatMap((entry) => entry.mentions))].join(' '),
      embeds: chunk.map((entry) => entry.embed),
      ...(trailerButtons.length
        ? { components: buildActionRows(trailerButtons) }
        : {}),
    }
  })
}

async function sendToDiscord(payload) {
  const webhookUrl = new URL(DISCORD_WEBHOOK)
  webhookUrl.searchParams.set('with_components', 'true')

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      typeof payload === 'string' ? { content: payload } : payload,
    ),
  })
  assertOk(res, 'Failed to send Discord webhook')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const remoteUserSettings = await fetchRemoteUserSettings()
  applyRemoteUserSettings(remoteUserSettings)
  const [airingToday, watchlistMap] = await Promise.all([
    fetchTodaysAiring(),
    fetchAllUserWatchlists(),
  ])
  const { watching, ptw } = getRelevantAnime(airingToday, watchlistMap)
  const groupedAnime = groupAnimeAudiences(watching, ptw, watchlistMap)

  if (NOTIFICATION_MODE === 'summary') {
    await sendToDiscord(formatSummaryMessage(groupedAnime, watchlistMap))
    return
  }

  if (NOTIFICATION_MODE !== 'release') {
    throw new Error(`Unsupported NOTIFICATION_MODE: ${NOTIFICATION_MODE}`)
  }

  const recentReleases = await fetchRecentSubsPleaseReleases()
  const releaseState = await loadReleaseState(nowTimestamp)
  const notifiedReleaseKeys = new Set(
    releaseState.notifiedReleases.map((entry) => entry.key),
  )
  const releasedWatching = attachReleaseInfo(
    watching,
    recentReleases,
    nowTimestamp,
  )
  const releasedPtw = attachReleaseInfo(ptw, recentReleases, nowTimestamp)
  const releasedGroups = groupAnimeAudiences(
    releasedWatching,
    releasedPtw,
    watchlistMap,
  )
  const newReleasedGroups = IGNORE_RELEASE_CACHE
    ? releasedGroups
    : releasedGroups.filter(
        (group) => !notifiedReleaseKeys.has(getReleaseKey(group.anime)),
      )
  const payloads = createReleasePayloads(newReleasedGroups, watchlistMap)

  if (!payloads.length) {
    console.log('No new released episodes to notify.')
    if (!IGNORE_RELEASE_CACHE) {
      await saveReleaseState(releaseState, nowTimestamp)
    }
    return
  }

  for (const payload of payloads) {
    await sendToDiscord(payload)
  }
  if (!IGNORE_RELEASE_CACHE) {
    await saveReleaseState(
      extendReleaseState(
        releaseState,
        newReleasedGroups.map((group) => group.anime),
      ),
      nowTimestamp,
    )
  }
}

export {
  fetchMalScheduleFallback,
  fetchTodaysAiring,
  findMatchingRelease,
  titleMatches,
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file:').href
) {
  main().catch(console.error)
}
