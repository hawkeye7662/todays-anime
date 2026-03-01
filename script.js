import fetch from 'node-fetch'

const API_URL = 'https://api.myanimelist.net/v2/users'
const COUNTDOWN_API = 'https://get-countdown.hawkeyesalt.workers.dev'

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
}

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

  for (const user of Object.keys(USERS)) {
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

      const viewerNames = anime.viewers.map((user) => {
        const { discordId, ping } = USERS[user]
        return ping && discordId ? `<@${discordId}>` : user
      })

      lines.push(`Viewers: ${viewerNames.join(', ')}`)
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
