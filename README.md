# Self-Evolving Superintelligence Lab

Public project homepage for the Co-evolving AI Scientist research framework. Affiliations: **UIUC × CMU × NVIDIA × Northeastern**. The author list follows the order in the research manuscript.

## Preview

Requires Node.js 20 or later; no dependencies or API keys.

```sh
npm run check
npm run build
npm start
```

Open `http://127.0.0.1:4173/self-evolving-superintelligence-lab/`.

## Publish to AI4SSI

Target repository: `AI4SSI/self-evolving-superintelligence-lab`.
Expected URL after deployment: https://ai4ssi.github.io/self-evolving-superintelligence-lab/

1. Create the public repository under AI4SSI and push these source files to its `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. The included `pages.yml` workflow validates and builds the site, then deploys only `dist/`.

The workflow uses the official [GitHub Pages Actions workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). No custom domain, backend, paid service, or credentials are embedded. The build allowlist excludes research SOPs and other workspace files.

## Edit the page

- `index.html`: project text, affiliations, resource links, video annotations.
- `styles.css`: original visual design and responsive layouts.
- `app.js`: Dry/Wet/Model tabs, horizontal video rail, annotation toggles, video playback, contents navigation.
- `assets/scientific-superintelligence-annotated.mp4`: first featured film in the horizontal rail. It already contains a 2× edit, so the browser plays the encoded file at 1×.
- `assets/recognize_bunny-3x.mp4`: second featured film, converted to browser-compatible H.264 from the supplied MPEG-4 Part 2 video; the 3× edit is already encoded.
- `assets/sub-1.mp4`, `assets/sub-2.mp4`: subsequent horizontal video section.
- `assets/overview-fume-hood.png`, `assets/render-main-final.png`: fume hood overview and rendered lab layout in the click-to-enlarge setup gallery.
- `digital-twin/`: public browser workbench integrated into the page, with the research twin’s 3D renderer and CAD-derived display models.

The featured films’ captions and 3×/2× speed markers are embedded in the supplied videos. The two supporting clips have toggleable HTML annotations. Native video controls remain available. Videos have descriptive labels and visible captions; no speech transcript was supplied. Motion-sensitive visitors receive a paused first video and reduced decorative motion.

The second supplementary video is converted from HEVC to H.264 for browser compatibility. Audio and visual content are preserved; source metadata is removed. The original input files in the parent workspace remain unchanged.

## Digital twin workbench

The embedded workbench runs directly in a visitor’s browser. Visitors can orbit and zoom the 3D bench, drag items, change their coordinates and rotation, add and remove items, adjust PiPER arm joints, preview a representative arm motion, save the layout locally, and import or export JSON. The 3D renderer and selected display models are from [self-evolving-lab-nature](https://github.com/xexlalalan/self-evolving-lab-nature), which currently requires GitHub access. Three.js r170 is bundled under its MIT license in `digital-twin/vendor/LICENSE`.

The public workbench uses a browser state and a visual motion preview. It does not connect to the research repository’s local Astra harness, planner, sensors, or real arm. It must not be treated as a collision-checked robot program. These boundaries are stated on the page. The complete research control panel in the source repository needs a separately operated backend; this GitHub Pages site provides a usable digital twin for public exploration without exposing that backend.

## Content and assets

- Research narrative and three-way co-evolution framework: project owner.
- Browser twin model and renderer: selected assets from the project owner’s research repository. The default arrangement is illustrative; bench dimensions come from the source twin.
- Videos and robotic workspace image: supplied project materials.
- Robot/chemistry logo: existing project branding; no bird motif.
- DM Sans font: bundled locally under the SIL Open Font License, included in `assets/FONT-LICENSE.txt`.
- Visual inspiration: [Stanford HomeBody project page](https://tml.stanford.edu/homebody/). This site uses original text, layout code, diagrams, and project media.
- Chemistry model: [Raven](https://ravenllm.com/).
- Robot skills: [ZiyaoG/piper_llm_skills](https://github.com/ZiyaoG/piper_llm_skills). This repository is private; its link is labeled as requiring GitHub access. Its visibility is independent of this public homepage.

The framework is described as a research direction. Demonstration videos document physical operations and do not claim measured autonomous recursive improvement or scientific performance benchmarks.
