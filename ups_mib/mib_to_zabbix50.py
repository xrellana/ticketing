#!/usr/bin/env python3
"""Generate Zabbix 5.0 SNMP templates from the Vertiv ENP MIB files."""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


ENTERPRISES_OID = (1, 3, 6, 1, 4, 1)
GROUP_NAME = "Templates/SNMP devices"
OUT_FILE = "zabbix_5.0_vertiv_enp_snmp_templates.xml"
SLIM_UPS_OUT_FILE = "zabbix_5.0_vertiv_ups_ita2_snmp_template_slim.xml"

SLIM_UPS_OBJECTS = {
    ("identManufacturer", "ident", 1),
    ("identModel", "ident", 2),
    ("phaseainputvoltage", "group2", 2),
    ("phasebinputvoltage", "group2", 3),
    ("phasecinputvoltage", "group2", 4),
    ("phaseaoutputvoltage", "group2", 5),
    ("phaseboutputvoltage", "group2", 6),
    ("phasecoutputvoltage", "group2", 7),
    ("phaseaoutputcurrent", "group2", 8),
    ("phaseboutputcurrent", "group2", 9),
    ("phasecoutputcurrent", "group2", 10),
    ("outputfrequency", "group2", 11),
    ("inputphasenumber", "group2", 12),
    ("lineabinputvoltage", "group2", 13),
    ("linebcinputvoltage", "group2", 14),
    ("linecainputvoltage", "group2", 15),
    ("phaseainputcurrent", "group2", 16),
    ("phasebinputcurrent", "group2", 17),
    ("phasecinputcurrent", "group2", 18),
    ("systeminputfrequency", "group2", 19),
    ("bypassfrequency", "group2", 29),
    ("outputphasenumber", "group2", 30),
    ("localphaseaoutputactivepow", "group2", 37),
    ("localphaseboutputactivepow", "group2", 38),
    ("localphasecoutputactivepow", "group2", 39),
    ("localphaseaoutputapparentp", "group2", 40),
    ("localphaseboutputapparentp", "group2", 41),
    ("localphasecoutputapparentp", "group2", 42),
    ("localphaseaoutputloadperce", "group2", 43),
    ("localphaseboutputloadperce", "group2", 44),
    ("localphasecoutputloadperce", "group2", 45),
    ("upsrunningtime", "group2", 56),
    ("batteryvoltage", "group2", 57),
    ("batterychargingcurrent", "group2", 58),
    ("batterydischargecurrent", "group2", 59),
    ("batterybackuptime", "group2", 63),
    ("batterytemperature", "group2", 64),
    ("batterycurrentcapacity", "group2", 66),
    ("inputpower", "group2", 68),
    ("outputpower", "group2", 69),
    ("powersupply", "group2", 70),
    ("inputpowerstatus", "group2", 71),
    ("batterystatus", "group2", 72),
    ("chargerstatus", "group2", 74),
    ("parallelsystempowerstate", "group2", 75),
    ("ineernetworkconnectionstatus", "group2", 76),
    ("inputabnormal", "group2", 79),
    ("systemovertemp", "group2", 80),
    ("systembatterylowprewarning", "group2", 81),
    ("rectifieroverload", "group2", 85),
    ("inverteroverload", "group2", 87),
    ("outputdisabled", "group2", 90),
    ("bypassabnormal", "group2", 91),
    ("bypassovercurrent", "group2", 94),
    ("batterylowprewarning", "group2", 97),
    ("batteryvoltabnormal", "group2", 98),
    ("nobattery", "group2", 99),
    ("batteryovertemp", "group2", 100),
    ("batteryaging", "group2", 101),
    ("batterytestfailure", "group2", 102),
    ("fanfailure", "group2", 104),
    ("lossofredundancy", "group2", 109),
    ("systemoverload", "group2", 110),
    ("batterymode", "group2", 115),
    ("bypassmode", "group2", 116),
    ("inverterfault", "group2", 122),
    ("outputshortcircuit", "group2", 127),
    ("outputoffandvoltageisnotz", "group2", 128),
    ("systemfault", "group2", 155),
    ("batteryeod", "group2", 156),
    ("upshasnooutput", "group2", 158),
    ("systemwarning", "group2", 160),
    ("outputvoltageabnormal", "group2", 161),
    ("communicationstatus", "group2", 164),
}


@dataclass
class MibObject:
    name: str
    parent: str
    subid: int
    oid: tuple[int, ...]
    syntax: str
    max_access: str
    description: str
    enum: tuple[tuple[int, str], ...]
    line: int
    table_column: bool


@dataclass
class Notification:
    name: str
    oid: tuple[int, ...]
    description: str


@dataclass
class MibModule:
    file: Path
    identity: str
    root_oid: tuple[int, ...]
    objects: list[MibObject]
    notifications: list[Notification]
    skipped: list[str]


ObjectFilter = Callable[[MibModule, MibObject], bool]


def clean_text(value: str) -> str:
    value = value.replace("\u2103", "degC")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n\s*", "\n", value)
    return value.strip()


def slug(value: str) -> str:
    value = value.replace("&", "and")
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return value or "unnamed"


def indent_xml(elem: ET.Element, level: int = 0) -> None:
    pad = "\n" + level * "    "
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = pad + "    "
        for child in elem:
            indent_xml(child, level + 1)
        if not child.tail or not child.tail.strip():
            child.tail = pad
    if level and (not elem.tail or not elem.tail.strip()):
        elem.tail = pad


def sub(parent: ET.Element, tag: str, text: str | int | None = None) -> ET.Element:
    child = ET.SubElement(parent, tag)
    if text is not None:
        child.text = str(text)
    return child


def line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def parse_enum(enum_text: str | None) -> tuple[tuple[int, str], ...]:
    if not enum_text:
        return ()
    pairs: list[tuple[int, str]] = []
    for name, value in re.findall(r"([A-Za-z0-9_-]+)\s*\(\s*(-?\d+)\s*\)", enum_text):
        pairs.append((int(value), name))
    return tuple(pairs)


def parse_syntax(body: str) -> tuple[str, tuple[tuple[int, str], ...]]:
    match = re.search(r"\bSYNTAX\s+([A-Za-z0-9_-]+)\s*(?:\{(.*?)\})?", body, re.S)
    if not match:
        return "", ()
    return match.group(1), parse_enum(match.group(2))


def parse_description(body: str) -> str:
    match = re.search(r'\bDESCRIPTION\s+"(.*?)"', body, re.S)
    if not match:
        return ""
    return clean_text(match.group(1))


def object_line_is_unnamed(line: str) -> bool:
    return bool(re.match(r"^\s+OBJECT-TYPE\b", line))


def collect_oid_nodes(text: str) -> dict[str, tuple[int, ...]]:
    nodes: dict[str, tuple[int, ...]] = {"enterprises": ENTERPRISES_OID}

    # MODULE-IDENTITY blocks are OID nodes too.
    module_re = re.compile(
        r"(?ms)^\s*([^\s]+)[ \t]+MODULE-IDENTITY\b.*?^\s*::=\s*\{\s*([^\s]+)\s+(\d+)\s*\}"
    )
    oid_re = re.compile(
        r"(?m)^\s*([^\s]+)[ \t]+OBJECT[ \t]+IDENTIFIER[ \t]+::=\s*\{\s*([^\s]+)\s+(\d+)\s*\}"
    )

    pending: list[tuple[str, str, int]] = []
    for match in module_re.finditer(text):
        pending.append((match.group(1), match.group(2), int(match.group(3))))
    for match in oid_re.finditer(text):
        pending.append((match.group(1), match.group(2), int(match.group(3))))

    # The MIBs define parents before children; repeat once for safety.
    for _ in range(3):
        changed = False
        for name, parent, subid in pending:
            if name in nodes or parent not in nodes:
                continue
            nodes[name] = nodes[parent] + (subid,)
            changed = True
        if not changed:
            break
    return nodes


def parent_chain(parent: str, node_parent: dict[str, str]) -> list[str]:
    chain: list[str] = []
    current = parent
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        chain.append(current)
        current = node_parent.get(current, "")
    return chain


def parse_mib(path: Path) -> MibModule:
    text = path.read_text(encoding="utf-8", errors="replace")
    nodes = collect_oid_nodes(text)
    node_parent: dict[str, str] = {}

    for match in re.finditer(
        r"(?m)^\s*([^\s]+)[ \t]+OBJECT[ \t]+IDENTIFIER[ \t]+::=\s*\{\s*([^\s]+)\s+\d+\s*\}",
        text,
    ):
        node_parent[match.group(1)] = match.group(2)
    for match in re.finditer(
        r"(?ms)^\s*([^\s]+)[ \t]+MODULE-IDENTITY\b.*?^\s*::=\s*\{\s*([^\s]+)\s+\d+\s*\}",
        text,
    ):
        node_parent[match.group(1)] = match.group(2)

    identity_match = re.search(r"(?m)^\s*([^\s]+)[ \t]+MODULE-IDENTITY\b", text)
    identity = identity_match.group(1) if identity_match else path.stem
    root_oid = nodes.get(identity, ())

    object_re = re.compile(
        r"(?ms)^\s*([^\s]+)[ \t]+OBJECT-TYPE\b(.*?^\s*::=\s*\{\s*([^\s]+)\s+(\d+)\s*\})"
    )
    objects: list[MibObject] = []
    skipped: list[str] = []
    seen_spans: list[tuple[int, int]] = []

    for match in object_re.finditer(text):
        name = match.group(1)
        body = match.group(2)
        parent = match.group(3)
        subid_value = int(match.group(4))
        line = line_number(text, match.start())
        seen_spans.append(match.span())

        if parent not in nodes:
            skipped.append(f"{path.name}:{line}: unresolved parent {parent} for {name}")
            continue

        syntax, enum = parse_syntax(body)
        max_match = re.search(r"\bMAX-ACCESS\s+([A-Za-z-]+)", body)
        max_access = max_match.group(1) if max_match else ""
        oid = nodes[parent] + (subid_value,)
        chain = parent_chain(parent, node_parent)
        table_column = any(part.lower().endswith("entry") for part in chain)
        description = parse_description(body)
        objects.append(
            MibObject(
                name=name,
                parent=parent,
                subid=subid_value,
                oid=oid,
                syntax=syntax,
                max_access=max_access,
                description=description,
                enum=enum,
                line=line,
                table_column=table_column,
            )
        )

        if max_access == "not-accessible":
            nodes[name] = oid
            node_parent[name] = parent

    for index, line in enumerate(text.splitlines(), start=1):
        if object_line_is_unnamed(line):
            skipped.append(f"{path.name}:{index}: unnamed OBJECT-TYPE skipped")

    notification_re = re.compile(
        r"(?ms)^\s*([^\s]+)[ \t]+NOTIFICATION-TYPE\b(.*?^\s*::=\s*\{\s*([^\s]+)\s+(\d+)\s*\})"
    )
    notifications: list[Notification] = []
    for match in notification_re.finditer(text):
        parent = match.group(3)
        if parent not in nodes:
            skipped.append(
                f"{path.name}:{line_number(text, match.start())}: unresolved notification parent {parent}"
            )
            continue
        notifications.append(
            Notification(
                name=match.group(1),
                oid=nodes[parent] + (int(match.group(4)),),
                description=parse_description(match.group(2)),
            )
        )

    return MibModule(
        file=path,
        identity=identity,
        root_oid=root_oid,
        objects=objects,
        notifications=notifications,
        skipped=skipped,
    )


def enum_map_name(enum: tuple[tuple[int, str], ...]) -> str:
    labels = "_".join(slug(label) for _, label in enum[:4])
    digest = hashlib.sha1(repr(enum).encode("utf-8")).hexdigest()[:8]
    return f"Vertiv enum {labels}_{digest}"[:128]


def value_type(obj: MibObject) -> str:
    if obj.syntax in {"DisplayString", "DateAndTime", "OCTET"}:
        return "CHAR"
    if obj.enum:
        return "UNSIGNED"
    if obj.syntax in {"Counter32", "Unsigned32", "Gauge32"}:
        return "UNSIGNED"
    return "FLOAT"


def unit_and_multiplier(description: str) -> tuple[str, str | None]:
    match = re.search(r"stored as\s+([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z%]+)?", description, re.I)
    if not match:
        return "", None

    multiplier = match.group(1)
    raw_unit = (match.group(2) or "").lower()
    unit_map = {
        "v": "V",
        "a": "A",
        "hz": "Hz",
        "kw": "kW",
        "kva": "kVA",
        "kwh": "kWh",
        "min": "min",
        "day": "d",
        "degc": "C",
        "sec": "s",
        "h": "h",
    }
    unit = "%" if raw_unit == "%" else unit_map.get(raw_unit, "")
    return unit, None if multiplier == "1" else multiplier


def application_for(obj: MibObject) -> str:
    name = obj.name.lower()
    desc = obj.description.lower()
    combined = f"{name} {desc}"

    if obj.parent == "ident" or name.startswith("ident"):
        return "Identification"
    if re.search(r"alarm|warning|fault|abnormal|failure|overtemp|overload|low|lost|short|eod|reversed|disabled|disable|aging|shutdown", combined):
        return "Alarms"
    if re.search(r"battery|charger", combined):
        return "Battery"
    if re.search(r"bypass", combined):
        return "Bypass"
    if re.search(r"input", combined):
        return "Input"
    if re.search(r"output|inverter|outlet", combined):
        return "Output"
    if re.search(
        r"sensor|door|smoke|warter|water|uninstalldi|temp\d|hum\d|temperature|hightemp|lowtemp|highhum|lowhum",
        combined,
    ):
        return "Sensors"
    if re.search(r"setting|config|delay|interval|test|turn|remote|selfstart|redundance|lognumber|automan|blocked|criterion|limit", combined):
        return "Settings"
    return "System"


def add_item(
    items_el: ET.Element,
    template_key: str,
    obj: MibObject,
    value_maps: dict[tuple[tuple[int, str], ...], str],
    duplicate_names: dict[str, int],
) -> None:
    item = sub(items_el, "item")
    item_name = obj.name
    if duplicate_names.get(obj.name, 0) > 1:
        item_name = f"{obj.name} ({obj.parent}.{obj.subid})"
    sub(item, "name", item_name)
    sub(item, "type", "SNMP_AGENT")
    sub(item, "snmp_oid", "." + ".".join(map(str, obj.oid + (0,))))
    sub(item, "key", f"vertiv.{template_key}.{slug(obj.name)}.{slug(obj.parent)}_{obj.subid}")
    sub(item, "delay", "1m")
    sub(item, "history", "90d")
    sub(item, "trends", "365d" if value_type(obj) in {"FLOAT", "UNSIGNED"} else "0")
    sub(item, "status", "ENABLED")
    sub(item, "value_type", value_type(obj))

    unit, multiplier = unit_and_multiplier(obj.description)
    if unit:
        sub(item, "units", unit)

    description_bits = []
    if obj.description:
        description_bits.append(obj.description)
    description_bits.append(f"MIB object: {obj.name}")
    description_bits.append(f"Numeric OID: .{'.'.join(map(str, obj.oid + (0,)))}")
    if obj.max_access == "read-write":
        description_bits.append("MIB MAX-ACCESS is read-write; this template only polls it with SNMP GET.")
    sub(item, "description", "\n".join(description_bits))

    apps = sub(item, "applications")
    app = sub(apps, "application")
    sub(app, "name", application_for(obj))

    if obj.enum:
        valuemap = sub(item, "valuemap")
        sub(valuemap, "name", value_maps[obj.enum])

    if multiplier:
        preprocessing = sub(item, "preprocessing")
        step = sub(preprocessing, "step")
        sub(step, "type", "MULTIPLIER")
        sub(step, "params", multiplier)
        sub(step, "error_handler", "ORIGINAL_ERROR")
        sub(step, "error_handler_params")


def add_trap_item(items_el: ET.Element, template_key: str, notification: Notification) -> None:
    item = sub(items_el, "item")
    oid = "." + ".".join(map(str, notification.oid))
    sub(item, "name", f"SNMP trap: {notification.name}")
    sub(item, "type", "SNMP_TRAP")
    sub(item, "key", f'snmptrap["{re.escape(oid)}"]')
    sub(item, "delay", "0")
    sub(item, "history", "90d")
    sub(item, "trends", "0")
    sub(item, "status", "DISABLED")
    sub(item, "value_type", "LOG")
    sub(item, "description", clean_text(notification.description) + f"\nNotification OID: {oid}")
    apps = sub(item, "applications")
    app = sub(apps, "application")
    sub(app, "name", "Traps")


def template_display_name(identity: str) -> str:
    clean = identity.replace("eNP-", "ENP ").replace("-", " ")
    return f"Template Vertiv {clean} SNMP"


def readable_objects(module: MibModule) -> list[MibObject]:
    result: list[MibObject] = []
    for obj in module.objects:
        if obj.max_access not in {"read-only", "read-write"}:
            continue
        if obj.table_column:
            continue
        result.append(obj)
    return result


def object_key(obj: MibObject) -> tuple[str, str, int]:
    return obj.name, obj.parent, obj.subid


def is_slim_ups_object(module: MibModule, obj: MibObject) -> bool:
    return module.identity == "eNP-UPS-ITA2" and object_key(obj) in SLIM_UPS_OBJECTS


def template_objects(module: MibModule, object_filter: ObjectFilter | None) -> list[MibObject]:
    objects = readable_objects(module)
    if object_filter is None:
        return objects
    return [obj for obj in objects if object_filter(module, obj)]


def build_export(
    modules: Iterable[MibModule],
    object_filter: ObjectFilter | None = None,
    template_name_suffix: str = "",
    extra_description_lines: Iterable[str] = (),
    include_traps: bool = True,
) -> ET.ElementTree:
    modules = list(modules)
    root = ET.Element("zabbix_export")
    sub(root, "version", "5.0")
    sub(root, "date", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    groups = sub(root, "groups")
    group = sub(groups, "group")
    sub(group, "name", GROUP_NAME)

    module_objects = [(module, template_objects(module, object_filter)) for module in modules]

    enum_maps: dict[tuple[tuple[int, str], ...], str] = {}
    for _, objects in module_objects:
        for obj in objects:
            if obj.enum and obj.enum not in enum_maps:
                enum_maps[obj.enum] = enum_map_name(obj.enum)

    templates = sub(root, "templates")
    for module, objects in module_objects:
        template_name = template_display_name(module.identity) + template_name_suffix
        template_key = slug(module.identity)
        template = sub(templates, "template")
        sub(template, "template", template_name)
        sub(template, "name", template_name)
        description_lines = [
            f"Generated from {module.file.name} for Zabbix 5.0 XML import.",
            f"Root OID: .{'.'.join(map(str, module.root_oid))}",
            "Scalar objects use numeric OIDs so Zabbix does not need these MIB files installed.",
            "SNMP trap items are disabled by default; enable them only after SNMP trap collection is configured.",
        ]
        description_lines.extend(extra_description_lines)
        sub(
            template,
            "description",
            "\n".join(description_lines),
        )
        template_groups = sub(template, "groups")
        template_group = sub(template_groups, "group")
        sub(template_group, "name", GROUP_NAME)

        app_names = {application_for(obj) for obj in objects}
        if include_traps and module.notifications:
            app_names.add("Traps")
        applications = sub(template, "applications")
        for app_name in sorted(app_names):
            app = sub(applications, "application")
            sub(app, "name", app_name)

        items = sub(template, "items")
        duplicate_names: dict[str, int] = {}
        for obj in objects:
            duplicate_names[obj.name] = duplicate_names.get(obj.name, 0) + 1
        for obj in objects:
            add_item(items, template_key, obj, enum_maps, duplicate_names)
        if include_traps:
            for notification in module.notifications:
                add_trap_item(items, template_key, notification)

    if enum_maps:
        value_maps = sub(root, "value_maps")
        for enum, name in sorted(enum_maps.items(), key=lambda pair: pair[1]):
            value_map = sub(value_maps, "value_map")
            sub(value_map, "name", name)
            mappings = sub(value_map, "mappings")
            for value, label in enum:
                mapping = sub(mappings, "mapping")
                sub(mapping, "value", value)
                sub(mapping, "newvalue", label)

    indent_xml(root)
    return ET.ElementTree(root)


def main() -> int:
    base = Path(__file__).resolve().parent
    mib_files = sorted(base.glob("*.mib"))
    if not mib_files:
        print("No .mib files found", file=sys.stderr)
        return 1

    modules = [parse_mib(path) for path in mib_files]
    tree = build_export(modules)
    out_path = base / OUT_FILE
    tree.write(out_path, encoding="utf-8", xml_declaration=True)

    ups_module = next((module for module in modules if module.identity == "eNP-UPS-ITA2"), None)
    if ups_module is not None:
        slim_tree = build_export(
            [ups_module],
            object_filter=is_slim_ups_object,
            template_name_suffix=" Slim",
            extra_description_lines=[
                "Slim UPS-only profile: identification, input/output electrical metrics, battery metrics, power state, communication state, and core UPS alarms.",
                "Write/control MIB objects and non-UPS ENV/RDU objects are intentionally excluded.",
            ],
        )
        slim_out_path = base / SLIM_UPS_OUT_FILE
        slim_tree.write(slim_out_path, encoding="utf-8", xml_declaration=True)
        print(f"Wrote {slim_out_path}")

    total_items = sum(len(readable_objects(module)) + len(module.notifications) for module in modules)
    slim_items = 0
    if ups_module is not None:
        slim_items = len(template_objects(ups_module, is_slim_ups_object)) + len(ups_module.notifications)
    skipped = [entry for module in modules for entry in module.skipped]
    print(f"Wrote {out_path}")
    print(f"Templates: {len(modules)}")
    print(f"Items: {total_items}")
    if ups_module is not None:
        print(f"Slim UPS items: {slim_items}")
    print(f"Skipped notices: {len(skipped)}")
    for entry in skipped:
        print(f"  - {entry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
