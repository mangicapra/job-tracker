# Job radar

Finds roles a person can actually take, scores them against their CV, and shows what's new since the last run. It works for any role and any person: each person gets a folder under `profiles/` with their CV, what they're looking for and the companies they want to watch.

Roles come from two places. The first is the public jobs_db API, a snapshot of US job listings from hiring.cafe, searched by the titles in the profile. The second is the public job-board APIs of the companies in the person's `watchlist.txt`. Greenhouse, Lever, Ashby, Workable and the others publish open roles as JSON so companies can show them on their careers pages, so the script never scrapes HTML or Google.

## Run it

Needs Node 18 or newer. No `npm install`.

```bash
node radar.mjs <name>            # both sources
node radar.mjs <name> --boards   # only the watchlist (fast, run this daily)
node radar.mjs <name> --db       # only jobs_db
node radar.mjs <name> --all      # also show roles they can't take, marked
```

If there's only one profile, you can leave out the name.

## Add a person

1. Copy `profiles/_template` to `profiles/<name>`. Folders starting with `_` are ignored.
2. Replace `cv.txt` with their CV as plain text: `pdftotext -layout cv.pdf cv.txt`, or copy and paste.
3. Edit `profile.json`:
   - `titles`: job titles to look for, e.g. `"frontend developer"`, `"react developer"`. Any role whose title contains one of these is considered.
   - `excludeTitles`: titles to drop even if they match, e.g. `"manager"` or `"intern"`.
   - `boostTitleWords` / `avoidTitleWords`: title words that push a role up or down the list, for focus or seniority.
   - `canWorkIn`: `"europe"`, `"us"` or `"anywhere"`. Decides which remote roles count as ones they can take.
   - `remoteOnly`: `true` keeps remote roles only, plus onsite roles in `localPlaces`.
   - `localPlaces`: cities or countries where onsite or hybrid work is fine for them.
   - `skills` (optional): a hand-written skill list. Leave it out to use automatic matching (see below).
4. Put company job-board links in their `watchlist.txt`. Any job link from the company works.

## How matching works

There are two modes.

**Automatic** (no `skills` in the profile). The script learns what matters from the ads themselves. It collects every word and two-word phrase across all matching ads, so things like "state management" or "a/b testing" come through whole. It drops filler words, locations and perks text. Terms that many ads for the role ask for count the most, and a role scores higher the more of those terms also appear in the CV. This works for any role straight away, from developers to designers to accountants. It gets more accurate the more ads it sees, so a run with a few dozen ads beats one with five. It's also more literal: if the CV says "customer conversations" and the ad says "user interviews", it won't connect them.

**Skill list** (`skills` in the profile). Each entry is `[label, pattern, weight]`, where the pattern is a regular expression that catches different wordings of the same skill. For example, `"(customer|user|creator) interviews?|user research"` all count as one skill, "customer interviews / user research". Weight 2 is for things employers screen on hard. This is more accurate and gives cleaner reports, but someone has to write the list for each kind of role.

A good approach for a new kind of role: start in automatic mode, read the keyword report, then turn the terms that matter into a skill list.

## What you get in `profiles/<name>/out/`

- `matches.csv`: every role they could take, best fit first. It shows what matched the CV and what the ad asks for that the CV doesn't show. After the first run, new roles are marked NEW and sorted to the top.
- `companies.csv`: every company hiring for those titles, with how many of its roles they could take. Use it to grow the watchlist and pick companies for direct outreach.
- `keyword-report.md`: what the better-matching ads ask for most, split into what's in the CV and what isn't. The board check at the bottom lists any watchlist link that didn't work.

## Reading the columns

`eligibility` is a best guess from the location and description text:
- `ok (worldwide)`, `ok (Europe)` or `ok (US)`: the ad points somewhere they can work.
- `maybe (Germany)`: remote but tied to one country, which sometimes means residents only.
- `check`: unclear, so read the ad.
- `local`: one of their `localPlaces`.
- `restricted (…)`: they can't take it. These are hidden unless you use `--all`.

`score` (0–100) is rough keyword overlap with the CV, plus the title boosts and penalties. Use it to sort the list, not as a verdict on any single role.

## Notes

- jobs_db only has US listings and is refreshed by hand by its owner, so for people outside the US the watchlist is usually the better source.
- Daily run (macOS/Linux): `crontab -e`, then add
  `0 8 * * * cd /path/to/job-radar && node radar.mjs <name> --boards`
