# Persona (derived 2026-06-08)

## Who they are

Chris Misztur, President & Founder of Mr. IIoT and Co-Founder of Data In Motion Enterprise (DIME) and Angel Parts. Based in the Greater Chicago Area. 25+ years doing IT/OT integration in manufacturing: 11 years running plant IT at Parkview Metal Products, 8 years as Digital Transformation Manager at MacLean-Fogg (a major automotive supplier), then founding Mr. IIoT in 2019. He has patents in embedded systems for maintenance data acquisition and IoT inventory management. He knows the factory floor from the inside out, not from a vendor's slide deck.

## What they build / sell

Four products, all aimed at manufacturers who need machine data without ripping out what's on the floor:

- **SHARC** (Simple Hardware Adapter for Remote Communications): a hardware IoT sensor adapter that connects any digital or analog industrial sensor (0-10V, 4-20mA, PNP/NPN) to any network and publishes telemetry over MQTT/JSON. Powers via PoE or 24Vdc. Five-minute install. No OEM quote required. Works as a one-way data diode for air-gapped or classified environments. Primary use: production counts, utilization, pressure, current, vibration on legacy equipment with no PLC involvement.

- **DIME** (Data In Motion Enterprise, datainmotionenterprise.com): a high-performance edge connector that speaks 50+ native industrial protocols (Fanuc CNC/Robots, Yaskawa, Siemens S7, Allen-Bradley/EtherNet-IP, Beckhoff ADS, Modbus, OPC-UA, MTConnect, SparkplugB, and more). Runs at the edge, sub-millisecond latency, zero custom code. Three-tier architecture: Connector (floor), Horizons (per-site management), Zenith (cloud fleet state). Replaces the five-figure OEM connectivity quote with a configurable edge appliance. AI-assisted setup from documentation.

- **i3X** (Industrial Information Interoperability Exchange, i3x.net): turns disparate sources (SQL databases, MTConnect, OPC-UA, CSV/Excel) into standardized, queryable i3X-compliant REST APIs with semantic models and no custom code. Auto schema discovery, multi-server aggregation, AI-powered BM25 search via MCP integration. Suite: i3xdb, i3xmt, i3xcsv, i3xopc, i3xview, i3xdash, i3xrag, i3X Explorer.

- **Tracebook** (tracebook.ai): AI tech support for machine OEMs. Ingests manuals, schematics, and resolved tickets into a per-machine-serial knowledge base and returns cited answers in under 45 seconds. White-label under the OEM's brand, multi-modal input (text/photo/video), closed-loop ticket escalation.

Also: **Angel Parts** (Dec 2025) — supply chain software and services, early-stage.

## Point of view

- Read at the signal level: for most brownfield connectivity problems, the right move is to capture signal-level inputs (proximity sensors, current loops) at the machine and publish over MQTT rather than opening the PLC program. You get cycle state, counts, and utilization without putting a running line at risk.
- Data at the point of decision: visibility without action is noise. The goal is putting the right number in front of the right person at the moment they can act on it.
- Grow output, not headcount: the constraint for most scaling manufacturers isn't capital, it's people. The right system lets the team you already have produce more.
- No vendor lock-in: open payloads (JSON/MQTT), standards-based delivery (MTConnect, OPC-UA, SparkplugB), and customer-owned data. The operator should be able to swap analytics tools without re-engineering connectivity.
- Brownfield reality: most plants have PLCs that have been patched in place for a decade by people who no longer work there, documentation is incomplete, and nobody wants to touch it. Good IIoT architecture works around that rather than requiring a PLC refactor.

## Voice

Matter-of-fact and practitioner. Declarative sentences from someone who has done this in a real plant, not a consultant who read the whitepapers. Specific mechanisms, numbers, and named protocols rather than category-level abstractions. No hype, no enthusiasm markers, no hedging. Leads with the substance, not the speaker. Comments reinforce the 5C framework (Connect, Collect, Combine, Compute, Convey) and the signal-level-first, no-vendor-lock-in worldview without name-dropping those labels.
