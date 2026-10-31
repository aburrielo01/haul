"""Fabrica el Atajo "Añadir a Haul" (sin firmar) en formato .shortcut (plist).

Cinco acciones:
  1. Obtener texto de la entrada   (lo que comparte la app: título + enlace)
  2. Texto: «texto» + salto + «entrada como URL»   (el texto cubre las apps, que
     mandan el enlace dentro; la coerción a URL cubre las páginas de Safari)
  3. Codificar URL                 (para que título, espacios y saltos quepan)
  4. Texto: https://haul-o6sv.onrender.com/#add=<codificado>
  5. Abrir URL                     (Haul saca el primer enlace y usa el título)

No usa «Obtener URLs de la entrada»: con lo que entregan las apps de Amazon y
Zalando (un texto y una URL) esa acción devuelve vacío (comprobado el 31/10/2026
con public/atajo/diagnostico.shortcut).

Uso: python3 scripts/make-shortcut.py https://dominio salida.shortcut
     shortcuts sign --mode anyone --input salida.shortcut --output public/atajo/anadir-a-haul.shortcut
"""
import plistlib
import sys
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://haul-o6sv.onrender.com"
OUT = sys.argv[2] if len(sys.argv) > 2 else "anadir-a-haul-unsigned.shortcut"

def uid():
    return str(uuid.uuid4()).upper()

u_texto, u_bruto, u_cod, u_final = uid(), uid(), uid(), uid()
ENTRADA = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}

def action(ident, **params):
    return {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params}

def token_string(string, attachments):
    return {"Value": {"string": string, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}

def ref(u, name):
    return {"OutputUUID": u, "OutputName": name, "Type": "ActionOutput"}

# 2. «texto» + "\n" + «entrada como URL»
bruto = token_string("\ufffc\n\ufffc", {
    # el texto primero: Haul saca el nombre de lo que va delante del primer enlace
    "{0, 1}": ref(u_texto, "Texto"),
    # la entrada como URL cubre las páginas de Safari (coerción a WFURLContentItem)
    "{2, 1}": {"Type": "ExtensionInput", "Aggrandizements": [
        {"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": "WFURLContentItem"},
    ]},
})

# 4. dirección de Haul + codificado
prefix = BASE.rstrip("/") + "/#add="
final = token_string(prefix + "￼", {"{%d, 1}" % len(prefix): ref(u_cod, "Codificado")})

actions = [
    action("is.workflow.actions.detect.text", UUID=u_texto, CustomOutputName="Texto", WFInput=ENTRADA),
    action("is.workflow.actions.gettext", UUID=u_bruto, WFTextActionText=bruto),
    # sin WFInput: toma la salida de la acción anterior (el texto en bruto)
    action("is.workflow.actions.urlencode", UUID=u_cod, CustomOutputName="Codificado", WFEncodeMode="Encode"),
    action("is.workflow.actions.gettext", UUID=u_final, WFTextActionText=final),
    action("is.workflow.actions.openurl", WFInput={"Value": ref(u_final, "Texto"), "WFSerializationType": "WFTextTokenAttachment"}),
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
print("escrito", OUT, "· adjunto final en posición", len(prefix))
