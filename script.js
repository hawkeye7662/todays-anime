import fetch from 'node-fetch'

const API_URL = 'https://api.myanimelist.net/v2/users'
const COUNTDOWN_API = 'https://get-countdown.hawkeyesalt.workers.dev'

const USERS = [
  'Fried_Saanto',
  'HawkEye7662',
  'Asteriful',
  'Keppix',
  'Ullas_22',
  'MiniJCm',
  'SpiralEnjoyAnime',
  'Ansmol',
  'ThunderCam777',
  'c4sian16',
  'elephantoChan',
]

const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK

async function main() {
  const animeMap = await fetchAllUserAnime()
  const animeWithTimes = await fetchTimestamps([...animeMap.values()])
  const todaysAnime = filterTodayUTC(animeWithTimes)
  const message = formatMessage(todaysAnime)

  await sendToDiscord(message)
}

main().catch(console.error)

async function fetchAllUserAnime() {
  const map = new Map()

  for (const user of USERS) {
    let url = `${API_URL}/${user}/animelist?status=watching&limit=100&fields=alternative_titles&nsfw=true`

    while (url) {
      const res = await fetch(url, {
        headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
      })

      if (!res.ok) break

      const data = await res.json()

      for (const { node } of data.data) {
        if (!map.has(node.id)) {
          map.set(node.id, { ...node, viewers: [] })
        }
        map.get(node.id).viewers.push(user)
      }

      url = data.paging?.next ?? null
    }
  }

  return map
}

async function fetchTimestamps(animeList) {
  const result = []

  for (const anime of animeList) {
    try {
      const res = await fetch(`${COUNTDOWN_API}/${anime.id}`)
      const data = await res.json()

      if (!data?.nextEpisodeAirDate) continue

      result.push({
        ...anime,
        timestamp: data.nextEpisodeAirDate,
      })
    } catch {}
  }

  return result
}
function filterTodayUTC(animeList) {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)

  const end = new Date()
  end.setUTCHours(23, 59, 59, 999)

  return animeList.filter((a) => {
    const t = a.timestamp * 1000
    return t >= start.getTime() && t <= end.getTime()
  })
}
function formatMessage(animeList) {
  if (!animeList.length) {
    return "# Today's Anime\nNo anime airing today 😔"
  }

  const lines = ["# Today's Anime"]

  animeList
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((anime) => {
      lines.push(`## ${anime.alternative_titles?.en || anime.title}`)
      lines.push(`Viewers: ${anime.viewers.join(', ')}`)
      lines.push(`Time: <t:${anime.timestamp}>`)
    })

  return lines.join('\n')
}
async function sendToDiscord(content) {
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}
