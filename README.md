## Complete Website Downloader 💾
Download the complete source code of any website (including all assets) 🔨.

👉 Live Demo: https://website-downloader.onrender.com

![enter image description here](https://github.com/AhmadIbrahiim/Website-downloader/blob/master/public/Record.gif?raw=true)
<div align="center">

  <a href="">![CodeFactor](https://www.codefactor.io/repository/github/ahmadibrahiim/website-downloader/badge)</a>

</div>

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

### Deploy on cloud providers
[![Run on Replit](https://binbashbanana.github.io/deploy-buttons/buttons/remade/replit.svg)](https://replit.com/github/AhmadIbrahiim/Website-downloader)
[![Remix on Glitch](https://binbashbanana.github.io/deploy-buttons/buttons/remade/glitch.svg)](https://glitch.com/edit/#!/import/github/AhmadIbrahiim/Website-downloader)
[![Deploy on Railway](https://binbashbanana.github.io/deploy-buttons/buttons/remade/railway.svg)](https://railway.app/new/template?template=https://github.com/AhmadIbrahiim/Website-downloader)
[![Deploy to Cyclic](https://binbashbanana.github.io/deploy-buttons/buttons/remade/cyclic.svg)](https://app.cyclic.sh/api/app/deploy/AhmadIbrahiim/Website-downloader)
[![Deploy to Koyeb](https://binbashbanana.github.io/deploy-buttons/buttons/remade/koyeb.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/AhmadIbrahiim/Website-downloader&branch=main&name=Website-downloader)
[![Deploy to Render](https://binbashbanana.github.io/deploy-buttons/buttons/remade/render.svg)](https://render.com/deploy?repo=https://github.com/AhmadIbrahiim/Website-downloader)


## Requirements 📦

- Node.js 16 or newer
- `wget` on the `PATH`. The app shells out to it, and nothing will download without it:
  - Debian/Ubuntu: `apt install wget`
  - macOS: `brew install wget`
  - Windows: `winget install JernejSimoncic.Wget`

## How to run it 🤔

- `git clone https://github.com/AhmadIbrahiim/Website-downloader.git`
- `cd Website-downloader`
- `$ npm install`
- `$ npm start`
- `http://localhost:3000/`

### Optional settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `DOWNLOAD_QUOTA` | `500m` | Size ceiling passed to wget, so one request cannot fill the disk |
| `DOWNLOAD_TIMEOUT_MS` | `600000` | How long a single download may run before it is stopped, lookup included |

Both ceilings went up when assets started coming down with the HTML. A site's
images and fonts are far bigger than its markup and take longer to fetch, and
the old `100m` / 5 minute limits cut most real sites off part way through.
Lower them again if you are running this somewhere with less disk or patience.

Raise `DOWNLOAD_TIMEOUT_MS` for anything large. A photo-heavy site of a few
dozen pages can easily run past ten minutes, and a download that runs out of
time is thrown away rather than saved part-finished, so the request comes back
as an error and nothing is kept. `DOWNLOAD_QUOTA` behaves better under
pressure: wget stops cleanly at the ceiling and whatever came down is still
archived.



# How To Contribute:
 - Open Issue(s) with any bugs you notice.
 - Please create Pull Requests if you think it would be an added value towards our program.

## Liked it ? You can buy a coffee:

<a href="https://www.buymeacoffee.com/aibrahim" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: 41px !important;width: 174px !important;box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;-webkit-box-shadow: 0px 3px 2px 0px rgba(190, 190, 190, 0.5) !important;" ></a>

Thank you,

Email: me@ahmed-ibrahim.com

https://www.ahmed-ibrahim.com
