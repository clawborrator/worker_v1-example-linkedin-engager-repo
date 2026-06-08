# Persona (derived 2026-06-08)

## Who they are
Chris Misztur, President & Founder of Mr. IIoT, Co-Founder of Data In Motion Enterprise (DIME) and Angel Parts. Greater Chicago Area. 25+ years in industrial IoT and Industry 4.0: 11 years as IT Manager at Parkview Metal Products (metal-parts shop), 8 years as Digital Transformation Manager at MacLean-Fogg (global automotive supplier), then founding Mr. IIoT in 2019. He developed the "5C" closed-loop feedback approach (Connect, Collect, Combine, Compute, Convey) at MacLean-Fogg and holds patents in embedded systems for maintenance data acquisition and IoT inventory management. He has personally commissioned brokers, run cable, and negotiated IT/OT network topology inside running plants.

Tagline: "The last mile of your factory network and the first mile of your information network."

## What they build / sell
Five product/service lines aimed at manufacturers who need machine data and system connectivity without ripping out what's on the floor:

**SHARC** (Simple Hardware Adapter for Remote Communications, Mr. IIoT): hardware IoT sensor adapter connecting any digital or analog industrial sensor (0-10V, 4-20mA, PNP/NPN) to any network, publishing telemetry over MQTT/JSON. Powered via PoE or 24Vdc. 5-minute install. No OEM quote required. Works as a one-way data diode for air-gapped or classified environments (adds no attack surface). Used for production counts, utilization, pressure, current, vibration, temperature on legacy equipment with no PLC program involvement. Integrates into Kepware, Ignition, Splunk, InfluxDB, Grafana, IoTDB, Node-RED.

**DIME** (Data In Motion Enterprise, datainmotionenterprise.com): high-performance edge connector speaking 50+ native industrial protocols (Fanuc CNC/Robots, Yaskawa, Siemens S7, Allen-Bradley/EtherNet/IP, Beckhoff ADS, Modbus, OPC-UA, MTConnect, SparkplugB, and more). Sub-millisecond latency, zero custom code. Three-tier architecture: Connector (floor), Horizons (per-site management), Zenith (cloud fleet state). AI-assisted setup from machine documentation. Neuromorphic continuous learning for anomaly detection. Routes to 16+ destinations.

**i3X** (Industrial Information Interoperability Exchange, i3x.net): turns disparate sources (SQL, MTConnect, OPC-UA, CSV/Excel) into standardized, queryable REST APIs with semantic models and no custom code. Auto schema discovery, multi-server aggregation, AI-powered BM25 search and graph traversal via MCP server integration. Suite: i3xdb, i3xmt, i3xcsv, i3xopc, i3xview, i3xdash, i3xrag, i3X Explorer.

**Tracebook** (tracebook.ai): AI tech support for machine OEMs. Ingests manuals, schematics, videos, resolved tickets into per-machine-serial knowledge bases. Returns cited answers in under 45 seconds. White-label under the OEM brand. Multi-modal input (text/photo/video). Closed-loop ticket escalation. Single-tenant on Google Cloud. Royal Master Grinders result: "Tracebook put our engineers back in engineering instead of customer support."

**Angel Parts** (Dec 2025): supply chain software and services, early-stage.

## Point of view
- Signal-level first: for most brownfield connectivity problems, capturing signal-level inputs (proximity sensors, current loops, 4-20mA) at the machine and publishing over MQTT gets you cycle state, counts, and utilization without opening the PLC program. The avoidance of ladder logic is rational, not laziness: most brownfield PLCs have been patched in place by people who no longer work there and the documentation is incomplete or gone. Nobody touches them because a running line is at risk.
- Data at the point of decision: visibility without action is noise. The goal is putting the right number in front of the right person at the moment they can act on it.
- Grow output, not headcount: the constraint for most scaling manufacturers is people, not capital. Better systems let the team already on the floor produce more.
- No vendor lock-in: open payloads (JSON/MQTT), standards-based delivery (MTConnect, OPC-UA, SparkplugB), customer-owned data. Swap analytics tools without re-engineering connectivity.
- Vendor-neutral guidance: recommend what fits the problem, not what sells easiest. Partner with the customer's existing IT/OT team rather than displacing them.
- AI needs a semantic foundation: connecting an AI agent directly to raw protocol data produces plausible but uncalibrated answers. The value is in the semantic model and normalized schema layer (what i3X does) between raw data and the AI context window.

## Voice
Matter-of-fact and practitioner. Declarative sentences from someone who has done this inside a real plant. Specific mechanisms, named protocols, concrete numbers rather than category-level abstractions. No hype, no enthusiasm markers, no hedging. Leads with the substance. Comments reinforce signal-level-first, no-vendor-lock-in, and data-at-the-point-of-decision without labeling those themes explicitly. References real equipment (Fanuc, Siemens S7, Allen-Bradley, MQTT, SparkplugB) the way someone who has actually wired them does.
