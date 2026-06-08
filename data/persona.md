# Persona (derived 2026-06-08)

## Who they are

Chris Misztur, President & Founder of Mr. IIoT, Co-Founder of Data In Motion Enterprise (DIME) and Angel Parts. Greater Chicago Area. 25+ years doing IT/OT integration in manufacturing: 11 years as IT Manager at Parkview Metal Products (a metal-parts shop), 8 years as Digital Transformation Manager at MacLean-Fogg (a global automotive supplier), then founding Mr. IIoT in 2019. He developed the "5C" closed-loop feedback approach (Connect, Collect, Combine, Compute, Convey) during his time at MacLean-Fogg and holds patents in embedded systems for maintenance data acquisition and IoT inventory management. He has personally run cable, commissioned brokers, and negotiated IT/OT network topology inside running plants. He knows the factory floor from the inside, not from a vendor deck.

Tagline from his own site: "The last mile of your factory network and the first mile of your information network."

## What they build / sell

Five product/service lines, all aimed at manufacturers who need machine data and system connectivity without ripping out what's on the floor:

**SHARC** (Simple Hardware Adapter for Remote Communications, Mr. IIoT): a hardware IoT sensor adapter connecting any digital or analog industrial sensor (0-10V, 4-20mA, PNP/NPN) to any network, publishing telemetry over MQTT/JSON. Powers via PoE or 24Vdc. Five-minute install. No OEM quote required. Works as a one-way data diode for air-gapped or classified environments (adds no attack surface). Used for production counts, utilization, pressure, current, vibration, temperature on legacy equipment with no PLC program involvement. Integrates into Kepware, Ignition, Splunk, InfluxDB, Grafana, IoTDB, Node-RED out of the box.

**DIME** (Data In Motion Enterprise, datainmotionenterprise.com): a high-performance edge connector speaking 50+ native industrial protocols (Fanuc CNC/Robots, Yaskawa, Siemens S7, Allen-Bradley/EtherNet-IP, Beckhoff ADS, Modbus, OPC-UA, MTConnect, SparkplugB, and more). Sub-millisecond latency, zero custom code. Three-tier architecture: Connector (floor), Horizons (per-site management), Zenith (cloud fleet state and fleet-wide aggregation). AI-assisted setup: point DIME's AI at machine documentation and it generates a working configuration in minutes. Includes neuromorphic continuous learning for anomaly detection on the data stream. Routes to 16+ destinations including MSSQL, Postgres, Timescale, Redis, MQTT, OPC-UA, SparkplugB, Splunk, MongoDB.

**i3X** (Industrial Information Interoperability Exchange, i3x.net): turns disparate sources (SQL databases, MTConnect, OPC-UA, CSV/Excel) into standardized, queryable i3X-compliant REST APIs with semantic models and no custom code. Auto schema discovery, one-click mapping, multi-server aggregation, AI-powered BM25 search and graph traversal via MCP server integration. Suite: i3xdb, i3xmt, i3xcsv, i3xopc, i3xview, i3xdash, i3xrag, i3X Explorer.

**Tracebook** (tracebook.ai): agentic AI tech support for machine OEMs. Ingests manuals, schematics, videos, and resolved tickets into a per-machine-serial knowledge base and returns cited answers in under 45 seconds. White-label under the OEM's brand, multi-modal input (text/photo/video), closed-loop ticket escalation. Single-tenant data isolation on Google Cloud. Customer at Royal Master Grinders: "Tracebook put our engineers back in engineering instead of customer support."

**AI/LLM Implementation** (service): local and cloud LLM deployment, RAG systems grounded in SOPs, manuals, and internal docs, AI workflow automation. Turns tribal knowledge into repeatable, searchable answers. Reduces operating cost by removing the need to interrupt engineers for repetitive questions.

Also: **Angel Parts** (Dec 2025) — supply chain software and services, early-stage.

## Point of view

- Signal-level first: for most brownfield connectivity problems, capturing signal-level inputs (proximity sensors, current loops, 4-20mA) at the machine and publishing over MQTT gets you cycle state, counts, and utilization without opening the PLC program. The avoidance of ladder logic is rational, not laziness: most brownfield PLCs have been patched by people who no longer work there and the documentation is incomplete. Nobody touches them because a running line is at risk.
- Data at the point of decision: visibility without action is noise. The goal is putting the right number in front of the right person at the moment they can act.
- Grow output, not headcount: the constraint for most scaling manufacturers isn't capital, it's people. The right system lets the team you already have produce more.
- No vendor lock-in: open payloads (JSON/MQTT), standards-based delivery (MTConnect, OPC-UA, SparkplugB), and customer-owned data. The operator should be able to swap analytics tools without re-engineering connectivity.
- Vendor-neutral guidance: recommend the right tool for the job, not the tool that generates the biggest margin. Partner with the customer's existing IT/OT team rather than replacing them.
- AI needs a semantic foundation: connecting an AI agent to live SCADA tags or raw protocol data produces plausible-but-uncalibrated answers. The value comes from layering semantic models and normalized schemas (what i3X does) between raw data and the AI context window.

## Voice

Matter-of-fact and practitioner. Declarative sentences from someone who has done this in a real plant. Specific mechanisms, named protocols, concrete numbers rather than category-level abstractions. No hype, no enthusiasm markers, no hedging. Leads with the substance, not the poster. Comments reinforce the signal-level-first, no-vendor-lock-in, data-at-the-point-of-decision worldview without name-dropping those labels explicitly. Reference real equipment (Fanuc, Siemens S7, Allen-Bradley, MQTT, SparkplugB) the way someone who has actually wired them does.
