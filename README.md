## Complete Website Downloader 💾
Download the complete source code of any website (including all assets) 🔨.

👉 Setup guide: https://gabriel-dalton.github.io/Website-downloader/

There is no hosted version of this fork. It runs on your own machine, because it
writes to disk and a media-heavy site can run to a gigabyte.

![enter image description here](https://github.com/Gabriel-Dalton/Website-downloader/blob/master/public/Record.gif?raw=true)

## Description 📒
 Website downloader works with `wget` and `archiver` to download all websites assets and compress then sends it back to the user through socket channel

### Assets on other hostnames

Most sites built on a hosted platform serve their stylesheets, scripts, images
and fonts from a CDN rather than from their own hostname. Squarespace, Wix,
Webflow and Shopify all work this way. `--page-requisites` will not cross a
hostname boundary on its own, so those sites used to come back as bare HTML:
every page, no styling, no pictures.

Telling wget to span hosts without qualification is not the answer either,
because it would follow the page's links to Facebook, YouTube and everywhere
else and start mirroring those too. So the entry page is fetched once before
the mirror starts and read for the hostnames it actually loads assets from:
`src`, `srcset`, `poster`, the lazy-loading `data-src` family, `<link href>`
and CSS `url()`. Plain `<a href>` links are ignored on purpose. Those hostnames,
plus the site's own name and its `www`/apex twin, become the allowlist handed
to `--domains`, capped at two dozen entries.

If that lookup fails for any reason the mirror still runs, just restricted to
the site's own hostname as before.

 **wget params the being used**

```
wget -mkEp -np -H --domains=<allowlist> --no-if-modified-since --quota=<quota> http://example.org
```

 **Explanation of the various flags:**

 - --mirror (-m) – Makes (among other things) the download recursive.
- --convert-links (-k) – convert all the links (also to stuff like CSS stylesheets) to relative, so it will be suitable for offline viewing.
- --adjust-extension (-E) – Adds suitable extensions to filenames (html or css) depending on their content-type.
- --page-requisites (-p) – Download things like CSS style-sheets and images required to properly display the page offline.
- --no-parent (-np) – When recursing do not ascend to the parent directory. It useful for restricting the download to only a portion of the site
- --span-hosts (-H) – Let the mirror leave the site's own hostname, which is the only way page requisites on a CDN get downloaded.
- --domains – The allowlist from the lookup above, which is what keeps `--span-hosts` from wandering off into the rest of the web.

This is deliberately one wget run. `--convert-links` only rewrites references
to files fetched during the same invocation, so fetching the CDN assets in a
second pass would leave the HTML pointing at the live internet.

### What you get in the zip

The archive root now holds one folder per hostname, plus a `START-HERE.html`
that redirects to the site's home page and links to it. Keep the folders
together: they are what the pages load their assets from.

### What still needs the internet

Being honest about the limits, since the point of this is offline use:

- Images that the site loads from JavaScript rather than from a real `src`
  attribute. wget cannot see a `data-src` that only becomes a `src` once a
  lazy-loading script runs, so those stay blank offline. Squarespace galleries
  and image blocks are the common case.
- Anything fetched at runtime: search, forms, comments, embedded maps, analytics
  and any other call to an API.
- Third-party embeds such as YouTube and Vimeo players, which live on hostnames
  the allowlist deliberately leaves out.
- Only the entry page is read for asset hostnames. A sub-page that pulls from a
  CDN nothing on the home page uses will still miss those files.

## Requirements 📦

- Node.js 16 or newer
- `wget` on the `PATH`. The app shells out to it, and nothing will download without it:
  - Debian/Ubuntu: `apt install wget`
  - macOS: `brew install wget`
  - Windows: `winget install JernejSimoncic.Wget`

## How to run it 🤔

- `git clone https://github.com/Gabriel-Dalton/Website-downloader.git`
- `cd Website-downloader`
- `$ npm install`
- `$ npm start`
- `http://localhost:3000/`

### Optional settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `DOWNLOAD_QUOTA` | `2g` | Size ceiling passed to wget, so a runaway crawl cannot fill the disk |
| `DOWNLOAD_TIMEOUT_MS` | `1800000` | How long a single download may run before it is stopped, lookup included |

These are deliberately high. This is meant to be run on your own machine, so
the limits exist to stop a runaway crawl rather than to ration a shared server.
A media-heavy site with assets included can reach a gigabyte, and the earlier
`100m` / 5 minute defaults cut most real sites off part way through. Lower them
if you are short on disk or patience.

The two behave differently when they bite. `DOWNLOAD_QUOTA` stops wget cleanly:
everything fetched so far is archived, and the result is flagged on the page as
incomplete rather than passed off as a finished download. `DOWNLOAD_TIMEOUT_MS`
throws the partial download away and returns an error, because a run cut off
mid-file cannot be trusted.



# How To Contribute:
 - Open Issue(s) with any bugs you notice.
 - Please create Pull Requests if you think it would be an added value towards our program.

## Credit

This is a fork of [AhmadIbrahiim/Website-downloader](https://github.com/AhmadIbrahiim/Website-downloader),
originally written by Ahmed Ibrahim ([ahmed-ibrahim.com](https://www.ahmed-ibrahim.com)),
MIT licensed. If the original was useful to you, you can
[buy Ahmed a coffee](https://www.buymeacoffee.com/aibrahim).

Changes in this fork: downloads that reported success while producing an empty
archive now report the failure, assets are pulled from the CDNs most modern
sites serve them from, and an incomplete mirror says so rather than passing
itself off as a whole site.
