# Caption template fonts

Fonts used by the Smoothy Pro caption templates in `../mogrt/`. A `.mogrt` does not embed fonts, so the desktop app copies the one a style needs into the user's font folder before the first send (`smoothyedit-app/src/main/captions/caption-fonts.ts`). Premiere lists a newly installed font after it restarts.

| File | Used by | Licence |
| --- | --- | --- |
| `PlusJakartaSans-ExtraBold.ttf` | Box | SIL OFL 1.1 (`PlusJakartaSans-OFL.txt`) |
| `InterDisplay-Bold.ttf` | Rise, Slide | SIL OFL 1.1 (`Inter-OFL.txt`), Inter 4.1 from github.com/rsms/inter |
| `InterDisplay-ExtraBold.ttf` | Outline | SIL OFL 1.1 (`Inter-OFL.txt`) |

Inter Display stands in for SF Pro Display, which Apple's licence does not allow us to bundle.
