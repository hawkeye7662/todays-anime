import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchTodaysAiring,
  findMatchingRelease,
  titleMatches,
} from '../script.js'

const NOW = 1_000_000

test('matches a shortened release title contained in the AniList title', () => {
  assert.equal(
    titleMatches(
      'Heroine? Saint? No, I’m an All-Works Maid (And Proud of It)!',
      'All Works Maid',
    ),
    true,
  )
})

test('matches season-wide feed episode numbers near the scheduled airing time', () => {
  const release = {
    releaseTitle: 'Re Zero kara Hajimeru Isekai Seikatsu',
    episode: 79,
    releasedAt: NOW - 60,
  }
  const anime = {
    airingAt: NOW - 120,
    episode: 13,
    titleEnglish: 'Re:ZERO -Starting Life in Another World- Season 4',
    titleRomaji: 'Re:Zero kara Hajimeru Isekai Seikatsu 4th Season',
    synonyms: [],
  }

  assert.equal(findMatchingRelease(anime, [release], NOW), release)
})

test('does not use an ambiguous or stale episode-number fallback', () => {
  const anime = {
    airingAt: NOW - 120,
    episode: 13,
    titleEnglish: 'Re:ZERO -Starting Life in Another World- Season 4',
    titleRomaji: 'Re:Zero kara Hajimeru Isekai Seikatsu 4th Season',
    synonyms: [],
  }

  assert.equal(
    findMatchingRelease(
      anime,
      [
        {
          releaseTitle: 'Re Zero kara Hajimeru Isekai Seikatsu',
          episode: 78,
          releasedAt: NOW - 60,
        },
        {
          releaseTitle: 'Re Zero kara Hajimeru Isekai Seikatsu',
          episode: 79,
          releasedAt: NOW - 30,
        },
      ],
      NOW,
    ),
    null,
  )
  assert.equal(
    findMatchingRelease(
      anime,
      [
        {
          releaseTitle: 'Re Zero kara Hajimeru Isekai Seikatsu',
          episode: 79,
          releasedAt: NOW - 7 * 60 * 60,
        },
      ],
      NOW,
    ),
    null,
  )
})

test('falls back to the MAL schedule Worker when AniList fails', async () => {
  const requests = []
  const request = async (url) => {
    requests.push(url)

    if (url === 'https://graphql.anilist.co') {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }
    }

    return {
      ok: true,
      json: async () => ({
        today: [
          {
            id: 123,
            title: 'Fallback Anime',
            unix: 1_788_787_800,
          },
        ],
      }),
    }
  }
  const originalWarn = console.warn
  console.warn = () => {}

  try {
    const airing = await fetchTodaysAiring(
      new Date('2026-09-07T12:00:00.000Z'),
      request,
    )

    assert.deepEqual(airing, [
      {
        anilistId: null,
        malId: 123,
        title: 'Fallback Anime',
        titleEnglish: 'Fallback Anime',
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
        episode: null,
        airingAt: 1_788_787_800,
      },
    ])
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(requests, [
    'https://graphql.anilist.co',
    'https://today.hzwk.workers.dev/',
  ])
})
