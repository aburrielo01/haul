"""Fabrica el Atajo "Añadir a Haul" (sin firmar) en formato .shortcut (plist).

Tres acciones:
  1. Obtener URLs de la entrada  (de la hoja de compartir: página de Safari, texto o enlace)
  2. Texto: https://haul-o6sv.onrender.com/#add=<URLs>
  3. Abrir URL
"""
import plistlib
import sys
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://haul-o6sv.onrender.com"
OUT = sys.argv[2] if len(sys.argv) > 2 else "anadir-a-haul-unsigned.shortcut"

uuid_links = str(uuid.uuid4()).upper()
uuid_text = str(uuid.uuid4()).upper()
prefix = BASE.rstrip("/") + "/#add="
text = prefix + "￼"  # el carácter de adjunto ocupa la posición len(prefix)

actions = [
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.detect.link",
        "WFWorkflowActionParameters": {
            "UUID": uuid_links,
            "CustomOutputName": "URLs",
            "WFInput": {
                "Value": {"Type": "ExtensionInput"},
                "WFSerializationType": "WFTextTokenAttachment",
            },
        },
    },
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {
            "UUID": uuid_text,
            "WFTextActionText": {
                "Value": {
                    "string": text,
                    "attachmentsByRange": {
                        "{%d, 1}" % len(prefix): {
                            "OutputUUID": uuid_links,
                            "OutputName": "URLs",
                            "Type": "ActionOutput",
                        }
                    },
                },
                "WFSerializationType": "WFTextTokenString",
            },
        },
    },
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.openurl",
        "WFWorkflowActionParameters": {
            "WFInput": {
                "Value": {
                    "OutputUUID": uuid_text,
                    "OutputName": "Texto",
                    "Type": "ActionOutput",
                },
                "WFSerializationType": "WFTextTokenAttachment",
            },
        },
    },
]

workflow = {
    "WFWorkflowClientVersion": "2607.1.3",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowIcon": {
        "WFWorkflowIconStartColor": 431817727,  # verde
        "WFWorkflowIconGlyphNumber": 59511,
    },
    "WFWorkflowImportQuestions": [],
    "WFWorkflowTypes": ["ActionExtension"],
    "WFQuickActionSurfaces": [],
    "WFWorkflowInputContentItemClasses": [
        "WFURLContentItem",
        "WFStringContentItem",
        "WFSafariWebPageContentItem",
        "WFRichTextContentItem",
        "WFArticleContentItem",
    ],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowActions": actions,
}

with open(OUT, "wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_XML)
print("escrito", OUT, "· adjunto en posición", len(prefix))
