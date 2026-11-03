"""Original SVG cover artwork for the fictional preview library."""
from pathlib import Path
from html import escape
import hashlib
import random
import re
import textwrap

PALETTES = [('071d31', '38849a', 'e5b16d'), ('151832', '6865a6', 'e9b99f'),
            ('102c2a', '3d8c80', 'f2d5a1'), ('2b1822', 'ad5c69', 'e4bd82')]


def poster_for(title):
    if title.startswith(('Midnight Archive', 'The Quiet Coast')):
        return None  # Exercise the no-artwork state too.
    folder = Path(__file__).resolve().parents[1] / 'frontend' / 'public' / 'demo-posters'
    folder.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    seed = int(hashlib.sha256(title.encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    background, middle, accent = PALETTES[seed % len(PALETTES)]
    stars = ''.join(f'<circle cx="{rng.randrange(24,376)}" cy="{rng.randrange(32,390)}" r="{rng.choice([0.6,1,1.5])}" fill="#f7eddd" opacity="{rng.uniform(.2,.7):.2f}"/>' for _ in range(60))
    motif = seed % 3
    if motif == 0:
        art = f'<circle cx="200" cy="215" r="108" fill="url(#planet)"/><ellipse cx="200" cy="235" rx="174" ry="36" fill="none" stroke="#{accent}" stroke-width="2" opacity=".75" transform="rotate(-26 200 235)"/><path d="M0 402 92 302 148 363 255 276 400 402V600H0Z" fill="#{background}"/>'
    elif motif == 1:
        art = f'<circle cx="200" cy="206" r="92" fill="#{accent}" opacity=".9"/>' + ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{440-y}" fill="#{background}"/>' for x,y,w in [(0,275,48),(42,230,38),(77,292,42),(118,258,40),(157,300,52),(207,242,40),(245,282,46),(286,221,40),(321,260,48),(364,295,36)])
        art += ''.join(f'<path d="M{x} {y}h4" stroke="#{accent}" opacity=".6"/>' for x in range(15,391,22) for y in range(315,400,22))
    else:
        art = f'<circle cx="200" cy="183" r="76" fill="#{accent}" opacity=".85"/>' + ''.join(f'<path d="M-30 {260+i*19} Q70 {185+i*24} 200 {270+i*17} T430 {250+i*20}" fill="none" stroke="#{accent}" stroke-width="{2 if i%2 else 1}" opacity="{.7-i*.045:.2f}"/>' for i in range(10))
    clean = re.sub(r'\s*\(\d{4}\)$','',title)
    lines = textwrap.wrap(clean.upper(), width=23)[:4]
    start = 480 - max(0,len(lines)-2)*21
    typography = ''.join(f'<tspan x="200" y="{start+i*29}">{escape(line)}</tspan>' for i,line in enumerate(lines))
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><title>{escape(title)} — original preview artwork</title><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#{background}"/><stop offset="1" stop-color="#{middle}"/></linearGradient><linearGradient id="planet" x2="1" y2="1"><stop stop-color="#{accent}"/><stop offset="1" stop-color="#{middle}"/></linearGradient><linearGradient id="shade" x2="0" y2="1"><stop stop-color="#{background}" stop-opacity="0"/><stop offset="1" stop-color="#{background}"/></linearGradient></defs><rect width="400" height="600" fill="url(#sky)"/>{stars}{art}<rect y="350" width="400" height="250" fill="url(#shade)"/><rect x="16" y="16" width="368" height="568" fill="none" stroke="#{accent}" stroke-opacity=".4"/><text x="200" y="49" fill="#{accent}" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" letter-spacing="4">ORIGINAL COLLECTION</text><text fill="#f6eee2" text-anchor="middle" font-family="Georgia,serif" font-size="25" letter-spacing="2">{typography}</text><path d="M172 550h56" stroke="#{accent}"/><text x="200" y="568" text-anchor="middle" fill="#{accent}" font-family="Arial,sans-serif" font-size="8" letter-spacing="3">MEDIA MONITOR</text></svg>'''
    (folder / f'{slug}.svg').write_text(svg, encoding='utf-8')
    return f'/demo-posters/{slug}.svg'
