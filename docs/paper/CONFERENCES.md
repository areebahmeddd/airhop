# Conferences and Publishing Guide

A plan for getting the Airhop and Airlink papers read, reviewed and presented, and for speaking from your DevOps and Kubernetes background. Checked on 17 November 2026. Dates move, so confirm each one on the official page before you submit.

**Legend:**

- **✓** confirmed on the official page or the organizer's own post.
- **_exp._** expected, based on last year's dates.
- **_unconfirmed_** means sources disagree, or the official site is not up yet.

**For** column:

- **A** = Airhop paper
- **L** = Airlink paper
- **B** = your background (DevOps, Kubernetes, open source)

## 1. How it all works

### The two worlds

**Research** publishes papers that a committee reviews. **Industry and community events** host talks that an organizer selects. They connect, but they work differently.

|                                            | Research                                                       | Industry and community                                        |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Where                                      | Conferences, workshops, journals (ACM, IEEE, USENIX, Springer) | KubeCon, Open Source Summit, FOSDEM, DEF CON, FOSSASIA        |
| You send                                   | A paper in the venue's template                                | A talk proposal: title, abstract, outline, bio                |
| Selected by                                | A program committee of researchers, often anonymously          | A program committee of practitioners                          |
| Result                                     | A publication with a DOI, in a digital library                 | A talk, usually recorded                                      |
| Can you send it to several places at once? | **No.** One paper, one venue at a time                         | **Yes.** Propose the same talk anywhere                       |
| Who pays                                   | You pay registration and sometimes a publication fee           | Speakers usually get a free pass. Some events also pay travel |

### How a research paper moves

1. **Call for papers (CFP).** The venue announces its topics, format, page limit and deadlines.
2. **Abstract registration.** Often a week before the deadline: you enter the title and abstract in the venue's submission system.
3. **Submission.** You upload the PDF. "AoE" (Anywhere on Earth) means the deadline lasts until midnight in the last time zone on Earth.
4. **Review:**
   - **Single-blind:** the reviewers know who you are.
   - **Double-blind:** they do not, so you hide your name and project names.
   - Some venues add a **rebuttal**, where you answer the reviewers.
5. **Notification.** Accept, reject, or accept with conditions (a "shepherd" checks the changes).
6. **Camera-ready.** You send the final version in the publisher's exact format and sign a copyright or license form.
7. **Registration and presentation.** At least one author must register (often at full price) and present it, as a talk or a poster.
8. **Proceedings.** The paper appears in ACM Digital Library, IEEE Xplore, Springer LNCS or USENIX, with a DOI. Indexes like DBLP, Scopus and Google Scholar pick it up.

### How the pieces connect for you

**White paper → arXiv preprint → talks** (any time, in parallel) **→ demo, poster or short paper at a workshop → full paper after field data → a journal version that extends it.**

- **Talks and preprints never block a paper.**
- **Dual submission:** sending the same paper to two venues at once does.
- **Journal versions:** a journal will usually accept an extended version of a conference paper if it adds substantial new material (often about 30%). Check each journal's rule.

### Terms you will see

| Term                                 | Meaning                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Conference / symposium               | The main venue type in computer science. Full papers, 6 to 13 pages                                                                 |
| Workshop                             | A smaller event attached to a conference. Shorter papers, easier entry, still peer reviewed                                         |
| Journal                              | Rolling submission, longer reviews (months), revisions. Often costs an APC if open access                                           |
| Poster / demo                        | A 1 to 4 page abstract. You present at a stand. The easiest way into a research venue                                               |
| Work-in-progress (WIP) / short paper | 4 to 6 pages on early results. Often a "WIP:" title prefix                                                                          |
| Experience paper                     | Lessons from building or deploying a system. Fits your situation well                                                               |
| SoK                                  | "Systematization of Knowledge": a survey with structure. Not your case                                                              |
| APC                                  | Article processing charge, the fee to publish open access                                                                           |
| DOI                                  | Permanent ID for a published item                                                                                                   |
| ORCID                                | Permanent ID for you as an author                                                                                                   |
| CORE rank                            | An unofficial ranking of venues: A\*, A, B, C. A rough guide to prestige                                                            |
| Artifact evaluation                  | An optional check that your code reproduces the paper                                                                               |
| Co-located event                     | A smaller event held next to a big one, in the same place and week. CNCF runs these on the day before KubeCon, with their own calls |
| Devroom / track / village            | A themed room inside a big event with its own call: FOSDEM devrooms, conference tracks, DEF CON villages                            |
| Lightning talk                       | 5 to 10 minutes. The easiest first talk                                                                                             |
| BoF                                  | "Birds of a feather": an open discussion session                                                                                    |
| Rejekts                              | Community events for talks KubeCon turned down                                                                                      |

## 2. Accounts and tools

| Tool                                                             | What it is for                                                                                                                            | When                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [ORCID](https://orcid.org)                                       | Your author ID                                                                                                                            | Now                  |
| [arXiv](https://arxiv.org)                                       | Preprints (section 4)                                                                                                                     | Now, linked to ORCID |
| [Zenodo](https://zenodo.org)                                     | Instant DOI, used as a fallback                                                                                                           | Only if needed       |
| [Sessionize](https://sessionize.com)                             | One speaker profile for KubeCon, Linux Foundation events, KCDs and many others                                                            | Now                  |
| [Pretalx](https://pretalx.com), [Eventyay](https://eventyay.com) | Talk calls for FOSDEM, CCC and FOSSASIA. One account per event                                                                            | When you submit      |
| HotCRP, EasyChair, EDAS, Microsoft CMT, OpenReview               | Paper submission systems. Each venue names its own: HotCRP is common at ACM and USENIX, EDAS at IEEE ComSoc, EasyChair at Springer venues | When you submit      |
| [LFX profile](https://openprofile.dev)                           | Linux Foundation event registration and the Travel Fund                                                                                   | Now                  |

**Prepare once, reuse everywhere:**

- a 3-sentence bio
- a headshot
- a 150-word abstract for each project
- a 2-minute demo video of each project
- the arXiv links, once posted

## 3. Your profile and what it opens

- **You:** 2026 computer science graduate in Bengaluru, starting an MBA at Monash University Malaysia in 2027.
- **Credentials and roles:**
  - CKA and AWS Solutions Architect
  - Linux Foundation LiFT scholar
  - ACM member, selected for the ACM Winter School
  - Open Food Facts maintainer
- **Work:** DevOps at Open Healthcare Network, where you moved a Kubernetes deployment from Google Cloud to Docker Swarm on EC2 and cut costs by 60%.
- **Projects:** two open-source systems with white papers.
- **Upstream contributions:** merged pull requests that reviewers can check:
  - CNCF projects: the OpenTelemetry Collector, Collector Contrib and eBPF profiler.
  - Docker: buildx, Model Runner, MCP Gateway.
  - Beckn ONIX: 9 merged, 3 open.
  - nostr-tools and bitchat-android.
  - Open Food Facts (Robotoff, Open Prices), OpenEverest.
- **Gaps:**
  - No field measurements yet, so the top research venues are long shots.
  - No research affiliation.
- **Strengths:**
  - working code
  - a written threat model
  - interoperability with bitchat
  - honest validation
  - real production DevOps stories
- **Funding levers:**
  - Your LiFT scholarship and an accepted talk make a strong Linux Foundation Travel Fund request.
  - From 2027, your MBA enrollment makes you a student for some grants.
- **Visas:**
  - With an Indian passport, the Schengen area, the UK, the US, Canada and Japan need visas, and US appointments can take months.
  - Ask for a multiple-entry Schengen visa, so one visa can cover more than one trip.
  - Bengaluru and Southeast Asia are the cheapest wins.

## 4. arXiv, step by step

arXiv does not peer review, but moderators check that a paper is research in the right category. Both papers qualify as system design and implementation papers.

1. **Register.** Use your real name and link ORCID.
2. **Get endorsed:**
   - **Why:** since January 2026, a new submitter needs a personal endorsement from an established author in the same area. An institutional email alone no longer counts, and arXiv staff cannot endorse ([arXiv](https://blog.arxiv.org/2026/01/21/attention-authors-updated-endorsement-policy/)).
   - **Your code:** start a submission in **cs.CR** to get an endorsement code.
   - **Finding an endorser:**
     - On arXiv pages of papers you cite or build on (BLE mesh, Briar, delay-tolerant networking, Tor pluggable transports, Nostr, Cashu, LoRa), click "Which authors of this paper are endorsers?"
     - Email **one** person at a time with the code, the PDF and three sentences on what the paper does.
3. **Upload TeX source, not a PDF.** arXiv rejects PDFs produced from TeX. Upload:
   - the `.tex` file
   - the `.bbl` file named like the `.tex`, or `references.bib`

   The figures are TikZ, so they are already inside the `.tex`.

4. **Fill in the fields:**

| Field                                      | Airhop                                                                                                                                  | Airlink                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Title                                      | Airhop: Offline-First Encrypted Messaging over a Bluetooth Mesh                                                                         | Airlink: Bounded Relay Nodes for the Airhop Bluetooth Mesh, with a Duty-Limited LoRa Trunk |
| Authors                                    | Areeb Ahmed Shariff                                                                                                                     | Areeb Ahmed Shariff                                                                        |
| Abstract                                   | Paste the paper's abstract as plain text (about 1,500 characters; the limit is 1,920). Replace `~` with a space and `10\,\%` with `10%` | Same                                                                                       |
| Comments                                   | `17 pages, 7 figures, 7 tables. Code: https://github.com/areebahmeddd/airhop`                                                           | `14 pages, 6 figures, 11 tables. Firmware: https://github.com/areebahmeddd/airlink`        |
| Primary category                           | cs.CR (Cryptography and Security)                                                                                                       | cs.NI (Networking and Internet Architecture)                                               |
| Cross-list                                 | cs.NI                                                                                                                                   | cs.CR                                                                                      |
| ACM class                                  | C.2.2; E.3; K.4.1                                                                                                                       | C.2.1; C.2.2; C.3                                                                          |
| MSC class, report number, journal-ref, DOI | Leave blank. Add the journal-ref and DOI later, if a venue publishes it                                                                 | Same                                                                                       |
| License                                    | CC BY 4.0 (permanent for that version)                                                                                                  | CC BY 4.0                                                                                  |

1. **Timing and rules:**
   - **Cutoff:** 14:00 US Eastern, which is 00:30 IST in winter.
   - **Announcement:** Sunday to Thursday evenings US time, which is the next morning in India.
   - **Limit:** at most two new submissions a month ([arXiv](https://blog.arxiv.org/2026/10/01/updated-rate-limit-policy/)).
   - **Order:** post Airhop first, then point the Airlink paper's citation at Airhop's arXiv ID.
   - **Before you submit:**
     - Keep the AI disclosure in the Acknowledgment.
     - Re-check every reference after any edit. arXiv is banning authors over unchecked references.
   - **Replacements:** at most once a week, and every version stays public.

**Fallbacks:**

- **Zenodo** gives a DOI with no endorsement.
- **Skip TechRxiv:** it says it rejects AI-assisted content.
- **IACR ePrint** suits Airhop only if cut down to its cryptographic constructions.

## 5. Calendar

Sorted by deadline. **Bold** marks the best fit in each window.

### Closing now: November and December 2026

| Deadline                | Event                                                                                                                                                                            | Submit                                                                             | For     | Why                                                                                                | Support            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| 20 Nov, 23:55 UTC ✓     | [FOSDEM, Decentralised Messaging room](https://matrix.org/blog/2026/10/30/fosdem-devroom/) (Brussels, 31 Jan)                                                                    | 25-min talk via [fosdem.org/submit](https://fosdem.org/submit)                     | A       | Messaging interoperability, run by Matrix, XMPP and Delta Chat                                     | None               |
| 20 Nov, 23:59 CET ✓     | [FOSDEM, Rust room](https://rust-fosdem.github.io/) (31 Jan)                                                                                                                     | 25-min talk                                                                        | B       | Embedding Arti, the Rust Tor client, in a React Native app (idea 2, section 7)                     | None               |
| 22 Nov ✓                | [ISOC Fellowship, Systems Security track](https://www.ndss-symposium.org/ndss2027/attend/internet-society-fellowship/)                                                           | Finish 3 online modules, then apply by 18 Dec                                      | A, L    | Up to $5,000 project funding, a mentor, travel to NDSS in Seoul. Not limited to students           | Funding            |
| 23 Nov, 23:59 UTC ✓     | [**FOSDEM, Embedded and Resource-Constrained OS room**](https://www.zephyrproject.org/fosdem-2027-call-for-proposals-for-the-embedded-resource-constrained-os-devroom/) (31 Jan) | 25-min or 10-min talk                                                              | L       | FreeRTOS and NimBLE in a fixed memory budget                                                       | None               |
| 25 Nov _unconfirmed_    | [COMSNETS demos](https://www.comsnets.org/demos_exhibits) (Bengaluru, 5 to 9 Jan)                                                                                                | Demo abstract, up to 4 pages                                                       | A + L   | At home. A live mesh needs no field data                                                           | Registration       |
| 30 Nov, 23:59 UTC ✓     | [**FOSDEM, Digital Dissident room**](https://talkweb.eu/openweb/4558/) (30 Jan)                                                                                                  | 20 to 30-min talk with a threat model                                              | A       | **Best talk fit.** The call asks for mesh messaging and shutdown resilience                        | None               |
| 30 Nov ✓                | [FOSDEM, Beyond the CRA room](https://openssf.org/event/fosdem-2027-beyond-the-cra-building-secure-and-resilient-open-source/) (30 Jan, morning)                                 | 10 or 20-min talk                                                                  | L       | Secure Boot, signed updates and rollback on a cheap device, framed for the EU Cyber Resilience Act | None               |
| 30 Nov, 23:59 Bangkok ✓ | [**FOSSASIA Summit**](https://eventyay.com/fossasia/summit2027/cfp) (Bangkok, 7 to 9 Mar)                                                                                        | One talk per track: Cybersecurity, Open Hardware, Cloud and DevOps, Web and Mobile | A, L, B | Close to Kuala Lumpur, one trip, several tracks                                                    | Not stated, so ask |
| 30 Nov, AoE ✓           | [FOSDEM, AI Plumbers room](https://aifoundry.org/fosdem-2027-ai-plumbers-dev-room) (31 Jan), co-run by Hugging Face and Red Hat                                                  | 25-min talk                                                                        | B       | Local model serving and sandboxing agents (topics table, section 7)                                | None               |
| Nov to Dec _exp._       | [Current Bengaluru](https://current.confluent.io/) (Confluent's Kafka event; 2026 edition was April)                                                                    | Talk                                                                               | B       | Kafka and event streaming, at home. The 2026 call ran 10 Nov to 22 Dec, so watch now               | At home            |
| 1 Dec, 23:59 CET ✓      | [FOSDEM, Testing and Continuous Delivery room](https://cd.foundation/blog/2026/11/05/fosdem-cfp-2027/) (30 Jan)                                                                  | 25-min or 10-min talk                                                              | B       | Testing a Bluetooth mesh with no radios (idea 3)                                                   | None               |
| 18 Dec ✓                | ISOC Fellowship application (above)                                                                                                                                              | Application                                                                        | A, L    |                                                                                                    |                    |

**At FOSDEM:**

- **Each talk goes to one room.** Different talks to different rooms are fine.
- **Pick two or three:** Digital Dissident and Embedded OS first, then Rust or Testing and CD.

### January to April 2027

| Deadline                 | Event                                                                                                                                                                           | Submit                                                                   | For        | Support                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------ |
| Dec to Jan _exp._        | [DEF CON Singapore 2](https://defcon.org/html/defcon-singapore/dc-singapore-index.html) (4 to 6 Mar)                                                                            | 20 or 45-min talk, or a demo lab                                         | A, L       | 2026 terms: 3 hotel nights, SGD 300, flight support from Asia                              |
| 3 Jan _unconfirmed_      | [Cloud Native Rejekts](https://cloud-native.rejekts.io/) (Barcelona, 13 to 14 Mar, before KubeCon Europe)                                                                       | 30-min or 5-min talk                                                     | B          | Free entry                                                                                 |
| 11 Jan ✓                 | [ACM HotMobile posters and demos](https://www.hotmobile.org/2027/index.php?id=cfp) (Tucson, 24 to 25 Feb)                                                                       | 1-page abstract, not anonymized                                          | A          | None found                                                                                 |
| 18 Jan, 23:59 Pacific ✓  | [AGNTCon + MCPCon North America](https://sessionize.com/agntcon-mcpcon-north-america-2027/) (San Francisco, 28 to 29 Apr), the Linux Foundation's agentic AI and MCP conference | Session via Sessionize                                                   | B (idea 6) | LF Travel Fund                                                                             |
| Open now, no date stated | [Global DPI Summit](https://www.globaldpisummit.org/) (Bali, 22 to 25 Mar), co-hosted by the UN, ITU, UNDP and the World Bank                                                   | Session proposal or country story                                        | B (idea 8) | Ask. Close to Kuala Lumpur                                                                 |
| Jan to Feb _exp._        | [Open Source Summit + Embedded Linux Conference, North America](https://events.linuxfoundation.org) (Vancouver, 17 to 19 May)                                                   | Session via Sessionize                                                   | L          | Free pass, [LF Travel Fund](https://events.linuxfoundation.org/about/travel-fund-request/) |
| Early Feb _exp._         | [**EWSN**](https://ewsn.org) (Thessaloniki, 27 to 30 Sep)                                                                                                                       | 6-page short or WIP paper, double-blind. Second round expected early May | L          | Check                                                                                      |
| Feb _exp._               | [SenSys demos and posters](https://sensys.acm.org/2027) (Boulder, 17 to 20 May)                                                                                                 | Demo or poster                                                           | L          | Registration                                                                               |
| 25 Feb _unconfirmed_     | [ISCRAM](https://iscram2027.com) (Perth, 6 to 9 Jun)                                                                                                                            | WIP paper, double-blind                                                  | A          | Open access                                                                                |
| Jan to Mar _exp._        | [KubeCon Japan](https://events.linuxfoundation.org/kubecon-cloudnativecon-japan/) (Yokohama, 25 to 26 Aug)                                                                      | Session via Sessionize                                                   | B          | LF Travel Fund                                                                             |
| Mar _exp._               | [Black Hat USA Arsenal](https://www.blackhat.com) (Las Vegas, Aug)                                                                                                              | Open-source tool demo                                                    | A          | Pass _unconfirmed_                                                                         |
| 31 Mar _exp._            | [TROOPERS](https://troopers.de) (Heidelberg, Jun)                                                                                                                               | 50-min talk                                                              | A, L       | 2025 terms: travel up to USD 1,800 and hotel                                               |
| 5 Apr ✓                  | [ACNS posters](https://acns2027.isg.rhul.ac.uk/calls/posters/) (Egham, UK, Jun)                                                                                                 | 5-page poster paper, in Springer proceedings                             | A          | None                                                                                       |
| 5 Apr _unconfirmed_      | ACM WiSec posters and demos (site not up yet)                                                                                                                                   | 2-page abstract                                                          | A, L       | Check                                                                                      |
| 15 Apr ✓ (tentative)     | [**FOCI, Issue 2**](https://foci.community) (Delft, 19 Jul, hybrid, with PETS)                                                                                                  | Experience paper, or 4 or 8 pages, double-blind                          | A          | PETS stipends                                                                              |

### May to December 2027

| Deadline          | Event                                                                                                                                                                                | Submit                                                                                | For           | Support                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------- | ---------------------------- |
| Feb to May _exp._ | [**Open Nexus India**](https://events.linuxfoundation.org/open-nexus-india/) (Bengaluru, 9 to 10 Sep): KubeCon India, Open Source Summit India and PyTorch Conference under one roof | Session via Sessionize                                                                | A, L, B       | At home                      |
| Mar to Jun _exp._ | [IndiaFOSS](https://fossunited.org/c/indiafoss) (Bengaluru, about Sep)                                                                                                               | Talk or devroom talk                                                                  | A, L, B       | At home                      |
| Feb to May _exp._ | [c0c0n](https://c0c0n.org) (Kochi, about Oct), run with Kerala Police                                                                                                                | Talk                                                                                  | B (idea 7), A | Check                        |
| Apr to May _exp._ | [IEEE LCN](https://www.ieeelcn.org) (Daytona Beach, Oct)                                                                                                                             | 6-page short paper or demo                                                            | L             | Limited student grants       |
| Mid-May _exp._    | HotPETs (Delft, Jul, with FOCI)                                                                                                                                                      | 1-page talk abstract                                                                  | A             | PETS stipends                |
| May to Jun _exp._ | DEF CON villages (Las Vegas, Aug): [Crypto & Privacy](https://cryptovillage.org/cfp) (A), RF Village (L)                                                                             | Village talk                                                                          | A, L          | Usually none                 |
| May to Jun _exp._ | KubeCon North America (Nov)                                                                                                                                                          | Session                                                                               | B             | LF Travel Fund               |
| Late Jun _exp._   | Open Source Summit + Embedded Linux Conference, Europe (Glasgow, 20 to 22 Sep)                                                                                                       | Session                                                                               | L             | LF Travel Fund               |
| Aug _exp._        | Open Source Summit Japan (Tokyo, Dec); Hackaday Supercon (Pasadena, Nov)                                                                                                             | Session or talk                                                                       | L             | LF Travel Fund for Japan     |
| Nov _exp._        | COMSNETS 2028 demos, posters, Graduate Forum (Bengaluru, Jan 2028)                                                                                                                   | Demo or poster. The Graduate Forum needs student enrollment, which your MBA gives you | A, L          | Graduate Forum travel grants |

### Funding with no fixed deadline

- **[Linux Foundation Travel Fund](https://events.linuxfoundation.org/about/travel-fund-request/):**
  - **How to apply:** register for the event, then apply from your LFX profile as soon as the talk is accepted.
  - **Covers:** economy flight, hotel, and airport transfers.
  - **Does not cover:** visas or meals.
  - **Limit:** usually one funded event a year.
- **[Open Technology Fund](https://www.opentech.fund):** rolling concept notes for internet freedom tools. Strong for Airhop.
- **HRF Bitcoin Development Fund:** has funded Cashu and messaging tools, and leads toward the Oslo Freedom Forum.
- **Global Gathering Equity Fund:** travel for digital rights work. Watch for the 2027 call around December or January.

## 6. Trips that stack

Plan around places, then fill each trip with several sessions, the way CNCF stacks co-located events around KubeCon.

| When                      | Where                   | Stack                                                                 | Note                                                             |
| ------------------------- | ----------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 5 to 9 Jan                | Bengaluru               | COMSNETS demo                                                         | No travel                                                        |
| 30 to 31 Jan              | Brussels                | FOSDEM: up to three talks in different rooms (A, L, B)                | Schengen visa. Ask for multiple entry                            |
| 4 to 9 Mar                | Singapore, then Bangkok | DEF CON Singapore (4 to 6), then FOSSASIA (7 to 9)                    | Back to back, near Kuala Lumpur. DEF CON helps with flights      |
| 13 to 18 Mar              | Barcelona               | Cloud Native Rejekts, KubeCon Europe as an attendee                   | Same Schengen visa as FOSDEM, if multiple entry                  |
| 22 to 26 Mar              | Seoul, or Bali          | NDSS through the ISOC Fellowship, or the Global DPI Summit            | Same week, so pick one. Bali is the short trip from Kuala Lumpur |
| 28 to 29 Apr              | San Francisco           | AGNTCon + MCPCon (idea 6)                                             | Only with LF Travel Fund approval and a US visa                  |
| Jul                       | Delft                   | PETS week: FOCI paper, HotPETs talk                                   | PETS stipends                                                    |
| 25 to 26 Aug              | Yokohama                | KubeCon Japan                                                         | LF Travel Fund                                                   |
| 9 to 10 Sep and about Sep | Bengaluru               | Open Nexus India (KubeCon, Open Source Summit, PyTorch) and IndiaFOSS | No travel. The best place for your first big-stage talk          |

## 7. What to submit

### The two papers

**Airhop:**

1. FOSDEM Digital Dissident.
2. FOSSASIA Cybersecurity.
3. COMSNETS demo.
4. arXiv in December.
5. DEF CON Singapore.
6. Field test.
7. FOCI experience paper.
8. HotPETs.
9. Open Nexus India or IndiaFOSS.

**Airlink:**

1. FOSDEM Embedded OS, or Beyond the CRA.
2. FOSSASIA Open Hardware.
3. arXiv.
4. Field test with two or three boards.
5. EWSN short paper.
6. SenSys demo.
7. The Embedded Linux Conference track at Open Source Summit North America or Europe.
8. IEEE LCN.

**Skip until field data exists:** full papers at USENIX Security, ACM CCS, NDSS, IEEE S&P, EuroS&P, PoPETs, MobiSys, MobiCom, CoNEXT and SECON. Also skip Black Hat Briefings, which want new attack research.

### Talks beyond the two papers

Every idea below comes from something you have actually built, in your repositories or at work. Reviewers turn down "intro to X" talks. They accept talks with a real decision, real numbers, and a lesson the audience can reuse.

**Start with these three:**

1. **Idea 1, leaving Kubernetes,** for KubeCon and DevOps rooms. It is the strongest story, because a certified Kubernetes administrator explaining when not to use Kubernetes stands out.
2. **Idea 6, the MCP registry and sandbox,** for AGNTCon + MCPCon (closes 18 Jan).
3. **Idea 8, OpenOutages,** for the Global DPI Summit in Bali and IndiaFOSS.

#### Cloud native and DevOps

| #   | Talk idea                                                                                                                                                                          | Based on                          | Best venues                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | **"We moved off Kubernetes and cut costs by 60%":** when Docker Swarm on EC2 beat GKE for a small team. A certified Kubernetes administrator explaining why and when, with numbers | Open Healthcare Network migration | Cloud Native Rejekts, KubeCon (Open Nexus India), FOSSASIA Cloud and DevOps, [Rootconf](https://hasgeek.com/rootconf) |
| 2   | **Embedding a Rust Tor client in a React Native app on iOS and Android:** catching panics across the boundary, plus pinned, reproducible builds whose hashes CI checks             | Airhop's Arti integration         | FOSDEM Rust (20 Nov), FOSSASIA Web and Mobile                                                                         |
| 3   | **Testing a Bluetooth mesh without radios:** 25 simulated phones on one virtual clock, adversarial scenarios, a bitchat client emulated in CI                                      | Airhop's simulation suite         | FOSDEM Testing and CD (1 Dec), KubeCon testing tracks                                                                 |
| 4   | **Secure Boot, signed updates and rollback on a $10 microcontroller:** what Cyber Resilience Act hardening costs on real firmware                                                  | Airlink                           | FOSDEM Beyond the CRA (30 Nov), Open Source Summit (Embedded Linux Conference), OpenSSF Community Day                 |
| 5   | **Shipping an app in 35 languages with no network fetch:** right-to-left layouts, a CI audit for hard-coded strings, every catalog compiled in for offline use                     | Airhop's localization             | FOSSASIA Web and Mobile, IndiaFOSS                                                                                    |

For idea 1, use the decision records you wrote ([care_adr](https://github.com/areebahmeddd/care_adr)) and the deploy scripts ([care_scripts](https://github.com/areebahmeddd/care_scripts)) as evidence, and check with Open Healthcare Network before sharing cost figures or architecture.

#### AI agents and tooling

| #   | Talk idea                                                                                                                                                                                                                     | Based on                                                                                                                                                                                                      | Best venues                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | **A registry and on-demand runner for untrusted MCP servers:** security scans before publishing, one Durable Object per session on Cloudflare Workers, and what isolation that does and does not give you                     | [superbox.ai](https://github.com/areebahmeddd/superbox.ai), [SuperBox-Executor](https://github.com/areebahmeddd/SuperBox-Executor), and your merged Docker MCP Gateway fix that reuses containers per session | [AGNTCon + MCPCon North America](https://sessionize.com/agntcon-mcpcon-north-america-2027/) (closes 18 Jan), AGNTSummit inside Open Nexus India, FOSSASIA AI track |
| 7   | **Asking questions of phone forensic reports in plain language, without breaking the chain of evidence:** normalizing UFDR exports, translating questions into search queries, and where a language model must not be trusted | [cognito.ai](https://github.com/areebahmeddd/cognito.ai) (Smart India Hackathon 2025)                                                                                                                         | c0c0n (Kochi, run with Kerala Police), FOSSASIA Cybersecurity                                                                                                      |

#### Civic tech and public infrastructure

| #   | Talk idea                                                                                                                                                                                                                   | Based on                                                                        | Best venues                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 8   | **India has over 50 power utilities and no public outage API:** a crowdsourced outage map on the Beckn protocol that confirms an outage at 4 reports from 3 people within 30 minutes                                        | [OpenOutages](https://github.com/areebahmeddd/OpenOutages)                      | [Global DPI Summit](https://www.globaldpisummit.org/) (Bali, call for sessions open), IndiaFOSS, FOSSASIA Open Source Ecosystems |
| 9   | **Trust without accounts:** stopping spam and fake reports when nobody signs in. A Bluetooth mesh with per-sender quotas, an outage map with confirmation thresholds, a pothole tracker with rate limits and photo evidence | Airhop, OpenOutages, [OpenPothole](https://github.com/areebahmeddd/OpenPothole) | Rootconf, FOSSASIA Cybersecurity, null Bangalore, IndiaFOSS                                                                      |
| 10  | **When the grid and the network fail together:** crowdsourced outage data and offline messaging, as two halves of one resilience plan                                                                                       | OpenOutages and Airhop                                                          | IndiaFOSS, RightsCon, an ISCRAM practitioner paper                                                                               |

#### Open data and bitcoin

| #   | Talk idea                                                                                                                                                     | Based on                                                                                                 | Best venues                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 11  | **Nutrition scores on any grocery store page:** matching barcodes across store sites, one extension for Chromium and Firefox                                  | [Open Food Facts extension](https://github.com/areebahmeddd/gsoc-prototype) (Google Summer of Code 2026) | IndiaFOSS, FOSSASIA Web and Mobile                                                               |
| 12  | **What chain analysis sees, and what ecash hides:** the heuristics you implemented on raw block files, set against Cashu tokens moving offline over Bluetooth | [sherlock-bitcoin](https://github.com/areebahmeddd/sherlock-bitcoin) (Summer of Bitcoin), Airhop         | bitcoin++ privacy editions ([btcpp.dev](https://btcpp.dev)), BTC Prague (curated, so email them) |

#### Building blocks, without naming the product

Each Airhop part, and each upstream project you contribute to, makes a talk of its own. Name the technique, not the app:

- **The title and abstract** teach something the audience can reuse.
- **Airhop** appears only as "a mesh messenger I built", with the link in your bio.

Product talks get rejected; technique talks with a working implementation get accepted.

| #   | Talk idea                                                                                                                                                                        | Based on                                                                                              | Best venues                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13  | **Many relays, one truth:** why a client must check an event's signature before treating copies from other relays as duplicates, or one relay's forgery hides the genuine event  | Your merged [nostr-tools](https://github.com/nbd-wtf/nostr-tools) relay-pool fix                      | FOSDEM Decentralised Messaging (20 Nov), FOSSASIA Web3, Nostr events (Nostrasia in Tokyo, Nostrshire in Manchester; no 2027 calls yet)                                               |
| 14  | **What a Nostr relay still learns:** gift wraps, a separate key per location channel, one key per relay connection, and the leaks that remain                                    | Airhop's internet path                                                                                | FOSDEM Digital Dissident (30 Nov), HotPETs, Nostr events                                                                                                                             |
| 15  | **Accepting ecash with no internet:** what a Cashu DLEQ proof proves offline, what it cannot (double spends), and the per-mint cap that bounds the loss                          | Airhop's wallet                                                                                       | FOSSASIA Web3 (30 Nov), bitcoin++ payments editions, BTC Prague, Adopting Bitcoin                                                                                                    |
| 16  | **A Double Ratchet for free:** seeding it from a third output of the Noise handshake, and the two obvious seeds that are unsafe                                                  | Airhop's sessions                                                                                     | FOSDEM Security (1 Dec, _unconfirmed_), DEF CON Crypto & Privacy Village, HotPETs, Real World Crypto 2028 (call about Oct 2027)                                                      |
| 17  | **Flooding without drowning:** TTL by neighbor count, relay jitter and duplicate windows that keep a phone mesh alive in a crowd                                                 | Airhop's routing                                                                                      | DEF CON RF Village, FOSDEM Network room, Hackaday Supercon                                                                                                                           |
| 18  | **Fail loudly in a protocol gateway:** returning a NACK when a transform fails instead of falling back silently, one coded error type, and an OpenTelemetry span on every plugin | Your 12 [Beckn ONIX](https://github.com/beckn/beckn-onix/pulls?q=author%3Aareebahmeddd) pull requests | Open Nexus India (Open Source Summit or KubeCon observability tracks), Global DPI Summit, IndiaFOSS, OpenTelemetry Community Day (expected next to Open Source Summit North America) |
| 19  | **SBOMs for a Kubernetes database operator:** generating them at release time and what consumers do with them                                                                    | Your merged OpenEverest SBOM work                                                                     | OpenSSF Community Day, FOSDEM Beyond the CRA (30 Nov), Data on Kubernetes Day (a KubeCon co-located event)                                                                           |

**Beckn:** there is no Beckn conference with an open call. Beckn talks belong at Digital Public Infrastructure events (the Global DPI Summit) and at India's open-source events. Idea 8 (OpenOutages, built on Beckn) and idea 18 (Beckn ONIX) pair well as one "building on Beckn" talk.

#### Topics you want to grow into

Some of these you already have public work in; for others you do not yet. A talk needs your own work behind it, so where the "You have" column is thin, build or contribute first, then propose.

| Topic                                                                                                                                                                    | You have                                                                                                                                        | Talk to aim for                                                                                                                                                              | Where                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Local model serving** (vLLM, Ollama)                                                                                                                                   | Merged Docker Model Runner pull requests (one binary for daemon and client, healthcheck, credential sync) and a llama.cpp fix in Docker's agent | **"Serving open models on one laptop to a small team":** Docker Model Runner, Ollama and vLLM compared on cold start, memory and API compatibility. Run the numbers yourself | FOSDEM AI Plumbers (30 Nov), PyTorch tracks at Open Nexus India, vLLM meetups in Bengaluru                       |
| **Mesh LLM** (pooling GPUs across machines, as in [Mesh-LLM](https://github.com/Mesh-LLM/mesh-llm))                                                                      | Gossip sync, duplicate windows and Sybil bounds from building a phone mesh                                                                      | **"What a phone mesh teaches a GPU mesh":** peer trust, gossip and resource limits when strangers share compute. Contribute to Mesh-LLM first so the talk has code behind it | FOSDEM AI Plumbers, FOSSASIA AI, AGNTSummit                                                                      |
| **Agent sandboxes** (Firecracker, [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox), [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview)) | SuperBox's per-session executor, and your Docker MCP Gateway fix                                                                                | **"Containers, microVMs or Durable Objects:** choosing isolation for untrusted agent tools," with your own measurements of startup time and escape surface                   | AGNTCon + MCPCon (18 Jan), FOSDEM Virtualization and Cloud Infrastructure room (deadline _unconfirmed_), KubeCon |
| **Noise protocol**                                                                                                                                                       | Noise XX with a ratchet seeded from it, Noise X for sealed mail                                                                                 | **"One framework, four handshakes":** the Noise patterns behind WireGuard (IK), Lightning (XK), libp2p (XX) and a Bluetooth mesh, and why each chose its pattern             | FOSDEM Security, DEF CON Crypto & Privacy Village, bitcoin++ (the Lightning angle)                               |
| **Nostr**                                                                                                                                                                | Ideas 13 and 14, your merged nostr-tools fix                                                                                                    | As above                                                                                                                                                                     | As above                                                                                                         |
| **Open Food Facts**                                                                                                                                                      | Merged Robotoff work (image auto-rotation, face flagging in product photos), Open Prices fixes, the browser extension                           | **"Finding faces in a crowdsourced product photo database":** a privacy problem in open data, and how Robotoff flags it                                                      | IndiaFOSS, FOSSASIA, PyCon India (call usually in spring, _exp._)                                                |
| **Kafka and message queues**                                                                                                                                             | Kafka on your résumé, a Redis Streams fix in Open Food Facts, OpenOutages' 60-second aggregation                                                | **"Confirming a power cut from crowd reports with stream windows":** rebuild OpenOutages' aggregation on Kafka or Redpanda, then talk about it                               | Current Bengaluru (watch now), Rootconf                                                                          |
| **Digital Energy Grid** ([Beckn DEG](https://github.com/beckn/DEG), from FIDE and the IEA)                                                                               | Your DEG fork, Beckn ONIX work, OpenOutages                                                                                                     | **"Outages are grid data too":** publishing crowdsourced outage reports as an open energy network service on Beckn                                                           | Global DPI Summit (Bali), DEG hackathons and summits (watch Beckn's blog and Luma), IndiaFOSS                    |

### Leads to grow the CNCF side of your profile

- **[Kubestronaut](https://www.cncf.io/training/kubestronaut/):** CNCF's title for people holding all five Kubernetes certifications. You already have the hardest (CKA).
- **[LFX Mentorship](https://mentorship.lfx.linuxfoundation.org):** paid, term-length mentorships on CNCF and Linux Foundation projects. A strong signal for KubeCon reviewers.
- **[Kubernetes Community Days](https://www.cncf.io/kcds/):** local one-day CNCF events, the easiest way into a CNCF talk. No 2027 Indian or Malaysian events are listed yet, so watch the page and the [Sessionize discover page](https://sessionize.com/app/speaker/discover).
- **Volunteering:** helping Hasgeek's Rootconf or the KubeCon India crew is a direct line to program committees.

## 8. The field test that opens doors

A small, honest measurement turns either paper into a real candidate for peer review.

- **Airhop:**
  - **Setup:** 6 to 10 phones (Android and iPhone), including one bitchat-ios and one bitchat-android phone.
  - **Measure:**
    - delivery rate and latency over 1 to 4 hops, indoors and outdoors
    - battery drain per hour
    - one courier walk between two groups
    - Tor bootstrap time
    - an interoperability matrix
- **Airlink:**
  - **Setup:** two or three boards.
  - **Measure:**
    - LoRa delivery rate at 1, 3 and 5 km
    - a log proving the duty-cycle limit holds
    - BLE relay throughput on the ESP32-S3 and the ESP32-C6
    - current draw
    - one over-the-air update with a rollback

Publish the results as version 2 on arXiv.

## 9. Writing each submission

**Talk proposal**

- **Title:** concrete, no marketing. For example, "Messaging through a shutdown: a Bluetooth mesh that stays compatible with bitchat".
- **Abstract, 150 to 300 words:** the problem, what you built, what the audience learns, and the evidence.
- **Outline:** fit it to the slot. For 25 minutes: problem 5, design 10, demo 5, questions 5.
- **Bio**, third person. For example: "Areeb Ahmed Shariff is a software engineer in Bengaluru and the author of Airhop and Airlink, an encrypted Bluetooth mesh messenger and its LoRa relay firmware. He is a Linux Foundation LiFT scholar, a Certified Kubernetes Administrator and a maintainer at Open Food Facts."
- **Links:** repositories, arXiv papers, the demo video, and any earlier talk recording.

**Short or work-in-progress paper**

- **Template:** use the venue's own: PoPETs for FOCI, ACM for EWSN, Springer LNCS for ACNS.
- **What to keep:** cut the white paper down to the one contribution the venue wants. For FOCI, the shutdown threat model and delivery paths. For EWSN, memory bounds, the duty-cycle ledger and flash wear.
- **Double-blind:** rename the system, link an anonymized copy of the code, and cite your own arXiv paper as if someone else wrote it, or not at all.

**Demo or poster**

- **Length:** 1 to 4 pages.
- **Content:** what people will see, the setup, and one figure.
- **Not anonymized.**
- **Bring a recorded backup.**

## 10. Speaking well

- **Rehearse at a Bengaluru meetup first:** null Bangalore, FOSS United, Hasgeek or BSides Bangalore. A recording strengthens every later proposal.
- **Be open about limits:** state the threat model and what is not measured, early on.
- **Demo live**, with a recorded fallback.
- **Finish on time.**
- **Afterwards,** publish the slides and the recording link in the repository.

## 11. Confirm before relying on these

**Unconfirmed:**

- **COMSNETS demo deadline:** check the page, or email the demo chairs.
- **ACM WiSec 2027:** the official site is not up yet.
- **Cloud Native Rejekts:** the call dates look carried over from an earlier year.
- **Rows marked _exp._:** set a reminder two weeks before each window.

**Where to find new calls:**

- [Sessionize Discover](https://sessionize.com/app/speaker/discover), which filters by travel support
- [Linux Foundation events calendar](https://events.linuxfoundation.org/about/calendar/)
- [kube.events](https://kube.events/call-for-papers)
- [confs.tech](https://confs.tech)
- [WikiCFP](http://www.wikicfp.com)
