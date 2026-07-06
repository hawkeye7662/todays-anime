import fetch from 'node-fetch'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID
const NOTIFICATION_MODE = process.env.NOTIFICATION_MODE ?? 'summary'
const SUBSPLEASE_RSS_URL = 'https://subsplease.org/rss/?t&r=1080'
const RELEASE_STATE_FILE =
  process.env.RELEASE_STATE_FILE ?? '.cache/todays-anime/releases.json'
const RELEASE_STATE_RETENTION_SECONDS = 14 * 24 * 60 * 60

const USERS = {
  Fried_Saanto: { discordId: '478945648906076160', ping: true },
  HawkEye7662: { discordId: '293712947623100416', ping: true },
  Asteriful: { discordId: '685632451707535394', ping: true },
  Keppix: { discordId: '533342860339183646', ping: true },
  Ullas_22: { discordId: '839559160071979089', ping: true },
  MiniJCm: { discordId: '791195889775411200', ping: true },
  SpiralEnjoyAnime: { discordId: '707975063835639949', ping: true },
  Ansmol: { discordId: '836253616532226149', ping: true },
  ThunderCam777: { discordId: '293101052675358721', ping: true },
  c4sian16: { discordId: '411153226835034122', ping: true },
  elephantoChan: { discordId: '606080832750485527', ping: true },
  EllesHere: { discordId: '264913847347838996', ping: true },
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
  const overlap = overlapCount(candidateWords, releaseWordSet)

  if (candidateWords.every((word) => releaseWordSet.has(word))) {
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

  return [...candidates].sort((a, b) => splitTitleWords(b).length - splitTitleWords(a).length)
}

function parseSubsPleaseFeed(xml) {
  const releases = []

  for (const item of xml.matchAll(SUBSPLEASE_ITEM_REGEX)) {
    const itemXml = item[1]
    const title = extractXmlField(itemXml, 'title')
    const link = extractXmlField(itemXml, 'link')
    const pubDate = extractXmlField(itemXml, 'pubDate')

    if (!title || !link || !pubDate || SUBSPLEASE_EXCLUDED_TITLE_REGEX.test(title)) {
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
    (anime) => anime.episode === 1 && watchlistMap.get(anime.malId).ptwers.length > 0,
  )

  return { relevant, watching, ptw }
}

function findMatchingRelease(anime, releases) {
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

  return null
}

function attachReleaseInfo(animeList, releases) {
  return animeList
    .map((anime) => {
      const release = findMatchingRelease(anime, releases)
      return release ? { ...anime, release } : null
    })
    .filter(Boolean)
}

function getReleaseKey(anime) {
  return `${anime.malId}:${anime.episode}:${anime.release.releasedAt}`
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

function filterUnnotifiedAnime(animeList, notifiedReleaseKeys) {
  return animeList.filter((anime) => !notifiedReleaseKeys.has(getReleaseKey(anime)))
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

async function fetchTodaysAiring() {
  const now = new Date()
  const startOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const endOfDay = startOfDay + 86400000 // +24h in ms

  const start = Math.floor(startOfDay / 1000)
  const end = Math.floor(endOfDay / 1000)

  const results = []
  let page = 1

  while (true) {
    const res = await fetch(ANILIST_URL, {
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
        episode: entry.episode,
        airingAt: entry.airingAt,
      })
    }

    if (!pageInfo.hasNextPage) break
    page++
  }

  return results
}

// ─── MAL user watchlists ──────────────────────────────────────────────────────

const MAL_API = 'https://api.myanimelist.net/v2/users'

async function fetchAllUserWatchlists() {
  // Returns a Map<malId, { watchers: string[], ptwers: string[] }>
  const map = new Map()

  for (const username of Object.keys(USERS)) {
    for (const status of ['watching', 'plan_to_watch']) {
      let url = `${MAL_API}/${username}/animelist?status=${status}&limit=100&nsfw=true`

      while (url) {
        const res = await fetch(url, {
          headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
        })
        assertOk(res, `Failed to fetch MAL list for ${username} (${status})`)
        const data = await res.json()
        for (const { node } of data.data) {
          if (!map.has(node.id)) map.set(node.id, { watchers: [], ptwers: [] })
          if (status === 'watching') {
            map.get(node.id).watchers.push(username)
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

function formatSummaryMessage(watching, ptw, watchlistMap) {
  if (!watching.length && !ptw.length) {
    return "# Today's Anime\nNo anime airing today 😔"
  }

  const lines = ["# Today's Anime"]

  for (const anime of watching) {
    const viewers = watchlistMap.get(anime.malId).watchers.map((username) => {
      const { discordId, ping } = USERS[username]
      return ping && discordId ? `<@${discordId}>` : username
    })
    lines.push(`## ${anime.title} (ep. ${anime.episode})`)
    lines.push(`Viewers: ${viewers.join(', ')}`)
    lines.push(`Time: <t:${anime.airingAt}>`)
  }

  if (ptw.length) {
    lines.push(`\n## 📋 Plan to Watch`)

    for (const anime of ptw) {
      const viewers = watchlistMap.get(anime.malId).ptwers.map((username) => {
        const { discordId, ping } = USERS[username]
        return ping && discordId ? `<@${discordId}>` : username
      })
      lines.push(`### ${anime.title}`)
      lines.push(`Viewers: ${viewers.join(', ')}`)
      lines.push(`Time: <t:${anime.airingAt}>`)
    }
  }

  return lines.join('\n')
}

function formatReleaseMessage(watching, ptw, watchlistMap) {
  if (!watching.length && !ptw.length) {
    return null
  }

  const lines = ['# Episodes Out Now']

  for (const anime of watching) {
    const viewers = watchlistMap.get(anime.malId).watchers.map((username) => {
      const { discordId, ping } = USERS[username]
      return ping && discordId ? `<@${discordId}>` : username
    })
    lines.push(`## ${anime.title} (ep. ${anime.episode})`)
    lines.push(`Viewers: ${viewers.join(', ')}`)
    lines.push(`Scheduled: <t:${anime.airingAt}>`)
    lines.push(`Released: <t:${anime.release.releasedAt}>`)
    lines.push(`Source: ${anime.release.link}`)
  }

  if (ptw.length) {
    lines.push(`\n## 📋 Plan to Watch`)

    for (const anime of ptw) {
      const viewers = watchlistMap.get(anime.malId).ptwers.map((username) => {
        const { discordId, ping } = USERS[username]
        return ping && discordId ? `<@${discordId}>` : username
      })
      lines.push(`### ${anime.title}`)
      lines.push(`Viewers: ${viewers.join(', ')}`)
      lines.push(`Scheduled: <t:${anime.airingAt}>`)
      lines.push(`Released: <t:${anime.release.releasedAt}>`)
      lines.push(`Source: ${anime.release.link}`)
    }
  }

  return lines.join('\n')
}

async function sendToDiscord(content) {
  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  assertOk(res, 'Failed to send Discord webhook')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const [airingToday, watchlistMap] = await Promise.all([
    fetchTodaysAiring(),
    fetchAllUserWatchlists(),
  ])
  const { watching, ptw } = getRelevantAnime(airingToday, watchlistMap)

  if (NOTIFICATION_MODE === 'summary') {
    await sendToDiscord(formatSummaryMessage(watching, ptw, watchlistMap))
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
  const releasedWatching = attachReleaseInfo(watching, recentReleases)
  const releasedPtw = attachReleaseInfo(ptw, recentReleases)
  const newWatching = filterUnnotifiedAnime(releasedWatching, notifiedReleaseKeys)
  const newPtw = filterUnnotifiedAnime(releasedPtw, notifiedReleaseKeys)
  const message = formatReleaseMessage(newWatching, newPtw, watchlistMap)

  if (!message) {
    console.log('No new released episodes to notify.')
    await saveReleaseState(releaseState, nowTimestamp)
    return
  }

  await sendToDiscord(message)
  await saveReleaseState(
    extendReleaseState(releaseState, [...newWatching, ...newPtw]),
    nowTimestamp,
  )
}

main().catch(console.error)
