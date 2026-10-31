"""Fabrica el Atajo "Haul diagnóstico" (sin firmar), para ver qué entrega una
app a un Atajo desde el menú Compartir. No abre Haul: enseña en pantalla el
tipo de la entrada, el texto, los enlaces que encuentra y la entrada tal cual,
y lo copia al portapapeles para pegarlo donde haga falta.

Uso: python3 scripts/make-diagnostico.py salida.shortcut
     shortcuts sign --mode anyone --input salida.shortcut --output public/atajo/diagnostico.shortcut
"""
import plistlib
import sys
import uuid

OUT = sys.argv[1] if len(sys.argv) > 1 else "diagnostico-unsigned.shortcut"

def uid():
    return str(uuid.uuid4()).upper()

u_tipo, u_urls, u_texto, u_resumen = uid(), uid(), uid(), uid()
ENTRADA = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}

def action(ident, **params):
    return {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params}

# Texto con cuatro adjuntos; cada "￼" ocupa una posición y se referencia por rango.
piezas = [
    ("Tipos: ", {"OutputUUID": u_tipo, "OutputName": "Tipo", "Type": "ActionOutput"}),
    ("\nURLs: ", {"OutputUUID": u_urls, "OutputName": "URLs", "Type": "ActionOutput"}),
    ("\nTexto: ", {"OutputUUID": u_texto, "OutputName": "Texto", "Type": "ActionOutput"}),
    ("\nEntrada tal cual: ", {"Type": "ExtensionInput"}),
]
string, attachments = "", {}
for literal, att in piezas:
    string += literal
    attachments["{%d, 1}" % len(string)] = att
    string += "￼"

resumen = {"Value": {"string": string, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}
ref_resumen = {"Value": {"OutputUUID": u_resumen, "OutputName": "Texto", "Type": "ActionOutput"}, "WFSerializationType": "WFTextTokenAttachment"}

actions = [
    action("is.workflow.actions.getitemtype", UUID=u_tipo, CustomOutputName="Tipo", WFInput=ENTRADA),
    action("is.workflow.actions.detect.link", UUID=u_urls, CustomOutputName="URLs", WFInput=ENTRADA),
    action("is.workflow.actions.detect.text", UUID=u_texto, CustomOutputName="Texto", WFInput=ENTRADA),
    action("is.workflow.actions.gettext", UUID=u_resumen, WFTextActionText=resumen),
    action("is.workflow.actions.setclipboard", WFInput=ref_resumen),
    action("is.workflow.actions.showresult", Text={"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {"OutputUUID": u_resumen, "OutputName": "Texto", "Type": "ActionOutput"}}}, "WFSerializationType": "WFTextTokenString"}),
]

workflow = {
    "WFWorkflowClientVersion": "2607.1.3",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59771},
    "WFWorkflowImportQuestions": [],
    "WFWorkflowTypes": ["ActionExtension"],
    "WFQuickActionSurfaces": [],
    # Acepta de todo, para aparecer en el menú Compartir de cualquier app.
    "WFWorkflowInputContentItemClasses": [
        "WFURLContentItem", "WFStringContentItem", "WFSafariWebPageContentItem",
        "WFRichTextContentItem", "WFArticleContentItem", "WFImageContentItem",
        "WFGenericFileContentItem", "WFPDFContentItem", "WFAppStoreAppContentItem",
        "WFiTunesProductContentItem", "WFMapsLinkContentItem", "WFContactContentItem",
        "WFLocationContentItem", "WFDateContentItem", "WFNumberContentItem",
    ],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowActions": actions,
}

with open(OUT, "wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_XML)
print("escrito", OUT)
