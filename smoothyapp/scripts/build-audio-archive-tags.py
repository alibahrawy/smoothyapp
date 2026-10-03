"""Build display metadata from pinned public archive snapshots.

Only unique title matches on both sides qualify; download URLs and license
fields from the metadata snapshot are never used.
"""
import collections
import json
from pathlib import Path
import re
import urllib.request
import unicodedata

METADATA_COMMIT = 'c1bb5a0812906726a501647772af6a030e644027'
METADATA_URL = f'https://raw.githubusercontent.com/operator-name/youtube-audio-library-download-all/{METADATA_COMMIT}/music/music-1000.json'
ARCHIVE_URL = 'https://raw.githubusercontent.com/ThibaultJanBeyer/YouTube-Free-Audio-Library-API/927b190ad00eef6696a17b33ed32ca897e7651d0/api.json'
GENRES = {'Dance & Electronic', 'Cinematic', 'Rock', 'Ambient', 'Hip Hop & Rap', 'Pop', 'Classical', 'Jazz & Blues', 'Country & Folk', 'R&B & Soul', "Children's", 'Alternative & Punk', 'Reggae', 'Holiday', 'World'}
ALIASES = {'Electronic': 'Dance & Electronic', 'Hip Hop': 'Hip Hop & Rap', 'Country and Folk': 'Country & Folk', 'Country Folk': 'Country & Folk'}
MOODS = {'dramatic', 'happy', 'dark', 'funky', 'calm', 'bright', 'inspirational', 'sad', 'angry', 'romantic'}

def read(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)

def key(title):
    return re.sub(r'[^\w]+', ' ', unicodedata.normalize('NFKC', title).casefold().replace('_', ' ')).strip()

metadata = collections.defaultdict(list)
for track in read(METADATA_URL)['tracks']:
    metadata[key(track['title'])].append(track)
archive = read(ARCHIVE_URL)['all']
archive_titles = collections.Counter(key(track['name'][:-4].replace('_', ' ')) for track in archive)
tags = {}
for track in archive:
    title = track['name'][:-4].replace('_', ' ').strip()
    matches = metadata[key(title)]
    if len(matches) != 1 or archive_titles[key(title)] != 1:
        continue
    item = matches[0]
    genre = ALIASES.get(item.get('genre'), item.get('genre'))
    mood = (item.get('mood') or '').lower()
    genre = genre if genre in GENRES else ''
    mood = mood.title() if mood in MOODS else ''
    artist = str(item.get('artist') or '').strip()[:300]
    duration = item.get('len')
    duration = duration if isinstance(duration, (int, float)) and 0 < duration < 86400 else 0
    if genre or mood or artist or duration:
        tags[track['id']] = [title, genre, mood, artist, duration]

output = Path(__file__).resolve().parent.parent / 'src/main/data/audio-archive-tags.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'source': {'url': METADATA_URL, 'snapshot': '2020-04-18', 'archive': ARCHIVE_URL, 'match': 'Unique normalized title on both sides; exact archive ID and title at runtime'}, 'tracks': dict(sorted(tags.items()))}, ensure_ascii=False, indent=2) + '\n')
print(f'Wrote {len(tags)} matched display records; {len(archive) - len(tags)} tracks remain untagged.')

# The server owns the ID/title allowlist; clients cannot insert arbitrary tracks.
server = output.parents[4] / 'web/src/data/audio-catalog.json'
if server.parents[2].is_dir():
    server.parent.mkdir(parents=True, exist_ok=True)
    server.write_text(json.dumps({t['id']: {'title': t['name'][:-4].replace('_', ' ').strip(), **({'genre': tags[t['id']][1], 'mood': tags[t['id']][2], 'artist': tags[t['id']][3], 'duration': tags[t['id']][4]} if t['id'] in tags else {})} for t in archive}, ensure_ascii=False, separators=(',', ':')) + '\n')
