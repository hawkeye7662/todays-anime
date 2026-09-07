# cron-job.org setup

This repo is set up for an external scheduler to trigger GitHub Actions with `workflow_dispatch`.

## Trigger URLs

Replace `YOUR_TOKEN` with a GitHub token that can dispatch workflows for this repository, and replace `REF` with the branch to run, usually `main`.

### Daily summary

`POST https://api.github.com/repos/hawkeye7662/todays-anime/actions/workflows/daily-anime.yml/dispatches`

Body:

```json
{
  "ref": "main"
}
```

### Release notifier

`POST https://api.github.com/repos/hawkeye7662/todays-anime/actions/workflows/anime-release-notifier.yml/dispatches`

Body:

```json
{
  "ref": "main"
}
```

## Required headers

```text
Accept: application/vnd.github+json
Authorization: Bearer YOUR_TOKEN
X-GitHub-Api-Version: 2026-03-10
Content-Type: application/json
```

## cron-job.org example

Create one cron-job.org job per workflow.

### Suggested daily summary job

- URL: the `daily-anime.yml` dispatch URL above
- Method: `POST`
- Schedule: your desired morning time
- Request body:

```json
{
  "ref": "main"
}
```

### Suggested release notifier job

- URL: the `anime-release-notifier.yml` dispatch URL above
- Method: `POST`
- Schedule: the exact times you want checked, such as every 30 minutes on the clock
- Request body:

```json
{
  "ref": "main"
}
```

## Notes

- The daily summary workflow posts the scheduled list for the day.
- The release notifier workflow posts only newly detected releases and uses `.cache/todays-anime/releases.json` to avoid reposting the same release.
- If AniList is unavailable, the script logs the failure and uses the deployed MAL schedule Worker at `https://today.hzwk.workers.dev/` instead.
- Manual runs from the GitHub Actions UI still work because both workflows keep `workflow_dispatch`.
