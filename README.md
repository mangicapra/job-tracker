# Job radar

Finds roles a person can actually take, scores them against their CV, and shows what's new since the last run. It works for any role and any person: each person gets a folder under `profiles/` with their CV, what they're looking for and the companies they want to watch.

Roles come from three places. The first is the public jobs_db API, a snapshot of US job listings from hiring.cafe, searched by the titles in the profile. The second is the public job-board APIs of the companies in the person's `watchlist.txt`. Greenhouse, Lever, Ashby, Workable and the others publish open roles as JSON so companies can show them on their careers pages. The third is the job sites in `sites.txt` that publish an API or feed: 4dayweek.io, the speedrun talent network, Working Nomads, Himalayas, Remote OK, We Work Remotely (RSS), and any other site with an RSS feed. The script never scrapes HTML or Google. Sites without a feed are listed in `sites.txt` with the reason they're not included.

The same role often shows up in several places, so duplicates are merged before anything is scored (see "Duplicates" below).

## Run it

Needs Node 18 or newer. No `npm install`.

```bash
node radar.mjs <name>                  # every source
node radar.mjs <name> --boards         # only the watchlist (fast, run this daily)
node radar.mjs <name> --sites          # only the job sites in sites.txt
node radar.mjs <name> --db             # only jobs_db
node radar.mjs <name> --boards --sites # flags combine
node radar.mjs <name> --all            # also show roles they can't take, marked
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
   - `homeCountry`: two-letter country code of where they live, e.g. `"BA"` for Bosnia and Herzegovina. Optional. Sites that can filter by it (currently Himalayas) then return only roles open to that country, worldwide roles included.
   - `remoteOnly`: `true` keeps remote roles only, plus onsite roles in `localPlaces`.
   - `localPlaces`: cities or countries where onsite or hybrid work is fine for them.
   - `skills` (optional): a hand-written skill list. Leave it out to use automatic matching (see below).
4. Put company job-board links in their `watchlist.txt`. Any job link from the company works.

## How matching works

There are two modes.

**Automatic** (no `skills` in the profile). The script learns what matters from the ads themselves. It collects every word and two-word phrase across all matching ads, so things like "state management" or "a/b testing" come through whole. It drops filler words, locations and perks text. Terms that many ads for the role ask for count the most, and a role scores higher the more of those terms also appear in the CV. This works for any role straight away, from developers to designers to accountants. It gets more accurate the more ads it sees, so a run with a few dozen ads beats one with five. It's also more literal: if the CV says "customer conversations" and the ad says "user interviews", it won't connect them.

**Skill list** (`skills` in the profile). Each entry is `[label, pattern, weight]`, where the pattern is a regular expression that catches different wordings of the same skill. For example, `"(customer|user|creator) interviews?|user research"` all count as one skill, "customer interviews / user research". Weight 2 is for things employers screen on hard. This is more accurate and gives cleaner reports, but someone has to write the list for each kind of role.

A good approach for a new kind of role: start in automatic mode, read the keyword report, then turn the terms that matter into a skill list.

## Job sites (`sites.txt`)

`sites.txt` is shared by every profile. Each site is searched with the titles from the profile being run. Remove a line to stop using a site. To add a site with an RSS feed, add `rss <feed url>`. You can put a comment after a site name with `#`.

Some sites ask for something in return for using their data. Remote OK and We Work Remotely ask for a link back and credit, 4dayweek and Himalayas ask for credit if you publish their jobs, and Himalayas doesn't allow passing its jobs on to other job boards. The CSVs always keep each job's link back to where it was found.

Himalayas and 4dayweek are searched once per title, with a pause between requests to stay under their rate limits. With many titles in a profile, these two take the most time: around a minute each for 20+ titles.

The euremotejobs line is a guess at their feed address. If it's wrong, the source check at the bottom of the keyword report will show it as not found.

## Duplicates

Before scoring, listings for the same role are merged into one row. Two listings count as the same role if they have the same link, or the same company and title after cleanup. The cleanup ignores legal suffixes ("RevenueCat, Inc." = "RevenueCat" = the `revenuecat` board), location tags in titles ("Product Owner (Remote)" or "Product Owner - EMEA" = "Product Owner"), "Sr" vs "Senior", and punctuation. The kept row comes from the best source: the company's own board first, then the job sites, then jobs_db, then aggregators. It picks up the best description and salary from the copies, lists every location, and names the other sources in the `also_on` column. The same thing catches a company posting one role in several cities, and repeated rows from jobs_db.

New roles are tracked per merged role too (see "Run history"), so a role you've already seen doesn't come back as new when another site reposts it. A role reposted with a completely different title will still show up as new, but that's rare.

## Run history

Every role the radar has ever found is remembered in `out/history.json`. Each run compares against it, so you only have to look at what's new.

- The first run counts everything as new. That's your starting point.
- After that, `new.csv` holds only the roles that weren't seen in any earlier run, and the terminal lists them.
- If nothing is new, the terminal says so and shows when the last run was.
- A dated copy of each run's new roles is kept in `out/history/`, for example `2026-11-24_0800-new.csv`. Runs with nothing new don't write a file.
- `runs.csv` logs every run: when, which sources, how many listings and roles, and how many were new.

A run that checks only some sources (for example `--boards`) still records what it found, so those roles won't show as new again on the next full run. To start over and treat everything as new again, delete `out/history.json`.

## What you get in `profiles/<name>/out/`

- `new.csv`: only the roles that are new since the last run, best fit first. This is the file to open every day.
- `matches.csv`: every role they could take that's open right now, one row per role, best fit first. It shows what matched the CV, what the ad asks for that the CV doesn't show, when the role was first seen, and the other sites it was also found on. New roles are marked NEW and sorted to the top.
- `companies.csv`: every company hiring for those titles, with how many of its roles they could take. Use it to grow the watchlist and pick companies for direct outreach.
- `runs.csv` and `history/`: the run log and the dated copies of each run's new roles (see "Run history").
- `keyword-report.md`: what the better-matching ads ask for most, split into what's in the CV and what isn't. The source check at the bottom shows how many roles each board and site returned, and any that failed.

## Reading the columns

`eligibility` is worked out mainly from the job's location field. The description only counts when it says outright where people can work from, like "work from anywhere", "remote within Europe" or "CET hours". A company calling itself "global" or mentioning customers in Europe doesn't count.
- `ok (worldwide)`, `ok (Europe)` or `ok (US)`: the location points somewhere they can work. "ad says so" means it came from an explicit line in the description.
- `ok (Bosnia)`: the role lists one of their `localPlaces` as a place it can be done from.
- `local (Sarajevo)`: an onsite or hybrid role in one of their `localPlaces`.
- `maybe (Germany)`: remote but tied to specific countries, which often means residents only. Read the ad.
- `check`: no usable location at all, so read the ad.
- `restricted (US)`: they can't take it. These are hidden unless you use `--all`.

jobs_db only has US listings, so a jobs_db role with no location is treated as US.

`score` (0–100) is rough keyword overlap with the CV, plus the title boosts and penalties. Use it to sort the list, not as a verdict on any single role.

## Keeping profiles private

Profiles hold a CV with contact details, so `.gitignore` keeps everything in `profiles/` out of git except `profiles/_template`, and keeps every `out/` folder out too. You can push the code to a public repo and keep your own profile folder on your computer.

If a profile was committed before the `.gitignore` was added, deleting the folder in a later commit doesn't remove it from the repo: it's still in the history. To remove it for good, rewrite the history (for example `git filter-repo --path profiles/<name> --invert-paths`, then force-push) or delete the repo on GitHub and push a fresh one.

## Notes

- jobs_db only has US listings and is refreshed by hand by its owner, so for people outside the US the watchlist is usually the better source.
- Daily run (macOS/Linux): `crontab -e`, then add
  `0 8 * * * cd /path/to/job-radar && node radar.mjs <name> --boards`
