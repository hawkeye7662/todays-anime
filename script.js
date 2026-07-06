import fetch from 'node-fetch'

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID

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
        }
      }
    }
  }
`

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
    const { data } = await res.json()
    const { airingSchedules, pageInfo } = data.Page

    for (const entry of airingSchedules) {
      results.push({
        anilistId: entry.media.id,
        malId: entry.media.idMal,
        title: entry.media.title.english || entry.media.title.romaji,
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
        if (!res.ok) break
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

function formatMessage(airingToday, watchlistMap) {
  const relevant = airingToday
    .filter((a) => a.malId && watchlistMap.has(a.malId))
    .sort((a, b) => a.airingAt - b.airingAt)

  const watching = relevant.filter(
    (a) => watchlistMap.get(a.malId).watchers.length > 0,
  )
  const ptw = relevant.filter(
    (a) => a.episode === 1 && watchlistMap.get(a.malId).ptwers.length > 0,
  )

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

async function sendToDiscord(content) {
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [airingToday, watchlistMap] = await Promise.all([
    fetchTodaysAiring(),
    fetchAllUserWatchlists(),
  ])
  const message = formatMessage(airingToday, watchlistMap)
  await sendToDiscord(message)
}

main().catch(console.error)
