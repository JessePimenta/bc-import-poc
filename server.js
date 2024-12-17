import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const app = express();
app.use(bodyParser.json());

// Serve the POC form + client logic at the root route
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Bandcamp Import POC</title>
  <meta charset="UTF-8">
</head>
<body>
  <h1>Bandcamp Import POC</h1>
  <form id="import-form">
    <label>Email: <input type="email" name="email" required/></label><br/>
    <label>Password: <input type="password" name="password" required/></label><br/>
    <label>Bandcamp Subdomain (e.g. yourlabel.bandcamp.com):
      <input type="text" name="subdomain" placeholder="yourlabel.bandcamp.com" required/>
    </label><br/>
    <button type="submit">Import</button>
  </form>
  <div id="results"></div>

  <script>
    const form = document.getElementById('import-form');
    const resultsDiv = document.getElementById('results');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const email = formData.get('email');
      const password = formData.get('password');
      const subdomain = formData.get('subdomain');

      resultsDiv.innerHTML = 'Importing...';

      try {
        const response = await fetch('/api/import-bandcamp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, subdomain })
        });

        const data = await response.json();

        if (!response.ok) {
          resultsDiv.innerHTML = \`<p style="color: red;">Error: \${data.error || 'Unknown'}</p>\`;
          return;
        }

        if (data.length === 0) {
          resultsDiv.innerHTML = '<p>No releases found or failed to import.</p>';
          return;
        }

        let html = '<h2>Imported Releases</h2><ul>';
        data.forEach((release) => {
          html += \`
            <li style="margin: 20px 0;">
              \${release.coverArt ? '<img src="' + release.coverArt + '" alt="Cover Art" style="max-width:100px; display:block;" />' : ''}
              <strong>Title:</strong> \${release.title}<br/>
              <strong>Artist:</strong> \${release.artist}<br/>
              <strong>Price:</strong> \${release.price}<br/>
              <strong>Description:</strong> \${release.description || 'None'}<br/>
              <strong>Tags:</strong> \${(release.tags || []).join(', ')}<br/>

              <strong>Tracks:</strong>
              <ul>
                \${(release.tracks || []).map((track, i) => \`<li>\${i+1}. \${track.title}</li>\`).join('')}
              </ul>
            </li>
          \`;
        });
        html += '</ul>';
        resultsDiv.innerHTML = html;

      } catch (err) {
        console.error(err);
        resultsDiv.innerHTML = '<p style="color: red;">Error importing releases.</p>';
      }
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

// Helper: login to Bandcamp (pseudo-OAuth)
async function authenticateBandcamp(email, password, subdomain) {
  // Clean up any leading protocol
  const cleanedSubdomain = subdomain.replace(/^https?:\/\//, '');
  const loginUrl = `https://${cleanedSubdomain}/login`;

  const payload = new URLSearchParams();
  payload.append('username', email);
  payload.append('password', password);

  console.log(`[authenticateBandcamp] Attempting login at ${loginUrl}...`);
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload
  });

  if (!response.ok) {
    throw new Error('Bandcamp login failed with status ' + response.status);
  }

  const setCookieHeader = response.headers.raw()['set-cookie'];
  if (!setCookieHeader) {
    throw new Error('[authenticateBandcamp] No Set-Cookie header returned. Login might have failed.');
  }

  // Merge all set-cookie lines into a single Cookie header
  const cookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
  console.log('[authenticateBandcamp] Cookies acquired:', cookies);
  return cookies;
}

// Gather /music page release URLs
async function getAllReleaseUrls(baseUrl, cookies) {
  console.log(`[getAllReleaseUrls] Fetching: ${baseUrl}/music`);
  const res = await fetch(baseUrl + '/music', { headers: { Cookie: cookies } });
  if (!res.ok) {
    throw new Error('Failed to load ' + baseUrl + '/music (status: ' + res.status + ')');
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const releaseLinks = [];
  $('.music-grid-item a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && href.startsWith('/album/')) {
      releaseLinks.push(baseUrl + href);
    }
  });

  console.log(`[getAllReleaseUrls] Found ${releaseLinks.length} album links.`);
  return releaseLinks;
}

// Parse each release page for metadata
async function parseReleasePage(releaseUrl, cookies) {
  console.log(`[parseReleasePage] Fetching: ${releaseUrl}`);
  const res = await fetch(releaseUrl, { headers: { Cookie: cookies } });
  if (!res.ok) {
    throw new Error('Failed to load release page: ' + releaseUrl + ' (status: ' + res.status + ')');
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  console.log('[parseReleasePage] Successfully loaded HTML. Searching for TralbumData...');

  let albumData = null;
  $('script').each((index, el) => {
    const scriptContent = $(el).html() || '';
    if (scriptContent.includes('var TralbumData =')) {
      console.log(`[parseReleasePage] Found TralbumData script at index ${index}`);
      const match = scriptContent.match(/var TralbumData\s*=\s*({.*?});/s);
      if (match && match[1]) {
        try {
          albumData = JSON.parse(match[1]);
          console.log('[parseReleasePage] Successfully parsed TralbumData JSON.');
        } catch (err) {
          console.log('[parseReleasePage] JSON parse error:', err);
        }
      }
    }
  });

  let title = 'Untitled';
  let artist = 'Unknown Artist';
  let coverArt = '';
  let price = 'N/A';
  let tags = [];
  let description = '';
  const tracks = [];

  function fallbackParseArtist($doc) {
    // Sometimes the .albumTitle has "TITLE, by ARTIST"
    const albumTitle = $doc('.albumTitle').text().trim();
    console.log(`[parseReleasePage] .albumTitle => "${albumTitle}"`);
    if (albumTitle.includes(', by ')) {
      const [titlePart, artistPart] = albumTitle.split(', by ');
      if (artistPart) {
        console.log(`[parseReleasePage] Splitting => artist="${artistPart.trim()}"`);
        return artistPart.trim();
      }
    }
    // If that doesn't work, check a .artist span
    const artistEl = $doc('.albumTitle .artist');
    if (artistEl.length) {
      const fallbackArtist = artistEl.text().trim();
      console.log(`[parseReleasePage] Found .albumTitle .artist => "${fallbackArtist}"`);
      return fallbackArtist;
    }
    return '';
  }

  if (albumData) {
    // Using JSON
    title = albumData.current?.title || 'Untitled';
    artist = albumData.current?.artist || albumData.artist || 'Unknown Artist';
    console.log(`[parseReleasePage] JSON => title="${title}", artist="${artist}"`);

    if (albumData.art_id) {
      coverArt = `https://f4.bcbits.com/img/a${albumData.art_id}_10.jpg`;
    }
    console.log(`[parseReleasePage] JSON => coverArt="${coverArt}"`);

    price = albumData.digital_price != null ? albumData.digital_price : 'N/A';
    tags = albumData.tags || [];
    description = albumData.current?.about || '';

    const trackInfo = albumData.trackinfo || [];
    trackInfo.forEach((t, i) => {
      const trackTitle = t.title || `Track ${i+1}`;
      tracks.push({ title: trackTitle });
    });

    if (!description) {
      console.log('[parseReleasePage] JSON description is empty, checking combined class .tralbumData.tralbum-about...');
      const descEl = $('.tralbumData.tralbum-about');
      if (descEl.length) {
        description = descEl.text().trim();
        console.log(`[parseReleasePage] Found .tralbumData.tralbum-about => "${description}"`);
      } else {
        const creditsEl = $('.tralbumData.tralbum-credits');
        if (creditsEl.length) {
          description = creditsEl.text().trim();
          console.log(`[parseReleasePage] Found .tralbumData.tralbum-credits => "${description}"`);
        } else {
          console.log('[parseReleasePage] No description found in HTML fallback for JSON case');
        }
      }
    }

    // If artist still missing, fallback parse
    if (!artist || artist === 'Unknown Artist') {
      console.log('[parseReleasePage] No artist in JSON, fallback parse .albumTitle...');
      const possibleArtist = fallbackParseArtist($);
      if (possibleArtist) {
        artist = possibleArtist;
      }
    }

  } else {
    // HTML fallback
    console.log('[parseReleasePage] No JSON found; using HTML fallback.');
    const ogTitle = $('meta[property="og:title"]').attr('content')
               || $('h2.trackTitle').text().trim()
               || 'Untitled';
    console.log(`[parseReleasePage] og:title => "${ogTitle}"`);

    if (ogTitle.includes(', by ')) {
      const [titlePart, artistPart] = ogTitle.split(', by ');
      title = titlePart.trim();
      artist = artistPart.trim();
    } else {
      title = ogTitle;
    }

    coverArt = $('meta[property="og:image"]').attr('content') || '';
    const priceEl = $('.buyItem .buyItemNyp, .buyItem .buyItemDigital');
    if (priceEl.length) {
      price = priceEl.text().trim();
    }

    // Tags
    tags = [];
    $('.tralbum-tags a').each((_, el) => {
      tags.push($(el).text().trim());
    });

    // Description from combined class (since it's the same element)
    let descEl = $('.tralbumData.tralbum-about');
    if (descEl.length) {
      description = descEl.text().trim();
      console.log(`[parseReleasePage] HTML fallback => .tralbumData.tralbum-about: "${description}"`);
    } else {
      // If no .tralbumData.tralbum-about found, check .tralbumData.tralbum-credits
      const creditsEl = $('.tralbumData.tralbum-credits');
      if (creditsEl.length) {
        description = creditsEl.text().trim();
        console.log(`[parseReleasePage] HTML fallback => .tralbumData.tralbum-credits: "${description}"`);
      } else {
        console.log('[parseReleasePage] HTML fallback => no description found');
      }
    }

    // If artist is still missing
    if (!artist) {
      const fallbackArtist = fallbackParseArtist($);
      if (fallbackArtist) {
        artist = fallbackArtist;
      }
    }

    // Tracks
    $('#track_table .track-title').each((_, el) => {
      tracks.push({ title: $(el).text().trim() });
    });
  }

  console.log(`[parseReleasePage] Final parse result:
    Title: "${title}"
    Artist: "${artist}"
    Price: "${price}"
    Description length: ${description?.length || 0}
    Tags: ${JSON.stringify(tags)}
    Tracks: ${tracks.map(t => t.title).join(', ')}
  `);

  return { title, artist, coverArt, price, tags, description, tracks };
}

// Main import endpoint
app.post('/api/import-bandcamp', async (req, res) => {
  const { email, password, subdomain } = req.body;
  if (!email || !password || !subdomain) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const cookies = await authenticateBandcamp(email, password, subdomain);
    const baseUrl = `https://${subdomain.replace(/^https?:\/\//, '')}`;

    const releaseUrls = await getAllReleaseUrls(baseUrl, cookies);

    const results = [];
    for (const url of releaseUrls) {
      const releaseData = await parseReleasePage(url, cookies);
      results.push(releaseData);
    }

    res.json(results);
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`POC server running on http://localhost:${PORT}`);
});
