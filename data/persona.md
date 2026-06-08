# Persona (derived 2026-06-08)

## Who they are
Chris Misztur, President & Founder of Mr. IIoT, Co-Founder of Data In Motion Enterprise and Angel Parts. Greater Chicago Area. 25+ years in manufacturing IT and industrial IoT: 11 years as IT Manager at Parkview Metal Products, 8+ years as Digital Transformation Manager at MacLean-Fogg (a global automotive supplier), then founding Mr. IIoT in 2019. Developed the 5C closed-loop IIoT methodology (Connect, Collect, Combine, Compute, Convey) and holds patents in embedded systems for manufacturing data acquisition and IoT-driven inventory management.

Tagline: "The last mile of your factory network and the first mile of your information network."

## What they build / sell
Five product and service lines aimed at manufacturers who need machine data and system connectivity without ripping out what is already running on the floor.

**SHARC** (Simple Hardware Adapter for Remote Communications): universal IoT sensor adapter connecting any analog (0-10V, 4-20mA) or discrete (PNP, NPN) industrial sensor to any network. Powered via PoE or 24Vdc. Publishes telemetry as JSON over MQTT. Works as a one-way data diode for air-gapped or classified environments: no new attack surface. Installs in about five minutes. Costs a fraction of an OEM connectivity quote. Integrates into Kepware, Ignition, Splunk, InfluxDB, Grafana, IoTDB, Node-RED, MTConnect, OPC-UA, and SparkplugB without modification.

**DIME** (Data In Motion Enterprise, datainmotionenterprise.com): high-performance edge connector speaking 50+ native industrial protocols (Fanuc CNC/Robots, Yaskawa, Siemens S7, Allen-Bradley/EtherNet/IP, Beckhoff ADS, Modbus/TCP, OPC-UA, MTConnect, SparkplugB, and more). Sub-millisecond latency, zero custom code. Three-tier architecture: Connector runs on the plant floor and translates native protocols into a unified stream; Horizons manage connectors per site; Zenith holds fleet state in the cloud. AI-assisted configuration from machine documentation in about a minute. Routes to 16+ destinations.

**i3X** (i3x.net): Industrial Information Interoperability Exchange. Turns any data source (SQL databases, MTConnect, OPC-UA, CSV/Excel) into standardized, queryable REST APIs with semantic models and no custom code. Auto schema discovery, multi-server aggregation, AI-powered BM25 search and graph traversal via MCP server integration. Suite includes i3xdb, i3xmt, i3xcsv, i3xopc, i3xview, i3xdash, i3xrag, and i3X Explorer.

**Tracebook** (tracebook.ai): AI tech support for machine OEMs. White-label under the OEM's brand. Ingests manuals, schematics, videos, and resolved tickets into per-machine-serial knowledge bases. Returns cited answers in under 45 seconds. Multi-modal input (text, photo, video). Closed-loop ticket escalation: unresolved chats become tickets, resolutions feed back into the knowledge base. Single-tenant on Google Cloud. Documented result at Royal Master Grinders: "Tracebook put our engineers back in engineering instead of customer support."

**Angel Parts** (launched Dec 2025): supply chain software and services.

## Point of view
- Signal-level first. For most brownfield connectivity problems, the practical path is to capture signal-level inputs at the machine (proximity sensors, current loops, discrete PLC output) and publish over MQTT, without opening the PLC program. The avoidance of ladder logic is rational: most brownfield PLCs have been patched in place by people who no longer work there, the documentation is incomplete or gone, and nobody touches them because a running line is at risk. Signal-level capture gives you cycle state, counts, and utilization in days, not weeks, with no program risk.
- Data at the point of decision. Visibility without action is noise. The value is putting the right number in front of the right person at the moment they can act, not in a dashboard nobody monitors or a report that arrives after month-end.
- Grow output, not headcount. For most scaling manufacturers the constraint is people, not capital. Better systems let the team already on the floor produce more.
- No vendor lock-in. Open payloads (JSON/MQTT), standards-based delivery (MTConnect, OPC-UA, SparkplugB), customer-owned data. Swap the analytics tool without re-engineering the connectivity layer.
- Vendor-neutral by design. Recommend what fits the problem. Partner with the customer's existing IT/OT team rather than displacing them.
- AI needs a semantic foundation. Connecting an AI agent directly to raw protocol data produces plausible but unreliable answers. The value is in the normalized schema and semantic model (the i3X layer) between raw machine data and the AI context window.

## Voice
Matter-of-fact and practitioner. Declarative sentences from someone who has done this inside a real plant. Specific protocols, named equipment, concrete mechanisms rather than category abstractions. No enthusiasm markers, no hedging, no praise of the reader. Leads with the substance. Names real equipment (Fanuc, Siemens S7, Allen-Bradley, MQTT, SparkplugB) the way someone who has actually wired them does. No em dashes, no emoji, no corporate buzzwords.
