"""Fabrica el Atajo "Añadir a Haul" (sin firmar) en formato .shortcut (plist).

Siete acciones:
  1. Obtener texto de la entrada        (lo que comparte la app: título + enlace dentro)
  2. Obtener URLs de la entrada (texto) (los enlaces de ese texto)
  3. Obtener URLs de la entrada (variable) (una página de Safari, si la acción la acepta así)
  4. Texto: «texto» + «URLs» + «URLs página» + «entrada», una por línea
  5. Codificar URL (entrada como texto) (para que título, espacios y saltos quepan)
  6. Texto: https://haul-o6sv.onrender.com/#add=<codificado>
  7. Abrir URL                          (Haul saca el primer enlace y usa el título)

Nada de convertir la entrada a URL (coerción): si uno de los elementos es un
texto que no es un enlace, la acción «Texto» falla en seco y el Atajo se para
("no ha podido convertir Texto en URL", visto el 31/10/2026 con Zalando).

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

u_texto, u_urls, u_urls2, u_bruto, u_cod, u_final = uid(), uid(), uid(), uid(), uid(), uid()
ENTRADA = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}

def action(ident, **params):
    return {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params}

def token_string(string, attachments):
    return {"Value": {"string": string, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}

def ref(u, name):
    return {"OutputUUID": u, "OutputName": name, "Type": "ActionOutput"}

def as_text(variable):
    """La variable metida en un campo de texto. «Codificar URL» y «Obtener URLs
    de la entrada» solo leen su entrada así: si se les pasa como variable
    suelta (WFTextTokenAttachment) devuelven vacío. Comprobado en el Mac el
    15/11/2026 con `shortcuts run` y nueve variantes; «Obtener texto» y
    «Base64» son al revés y quieren la variable suelta."""
    return token_string("\ufffc", {"{0, 1}": variable})

# 3. «texto» + "\n" + «URLs» + "\n" + «entrada de atajo»: el texto primero, porque
#    Haul saca el nombre de lo que va delante del primer enlace. Todo son
#    adjuntos sin coerción: nunca fallan, como mucho quedan vacíos.
bruto = token_string("\ufffc\n\ufffc\n\ufffc\n\ufffc", {
    "{0, 1}": ref(u_texto, "Texto"),        # apps: título + enlace
    "{2, 1}": ref(u_urls, "URLs"),          # enlaces encontrados en ese texto
    "{4, 1}": ref(u_urls2, "URLs página"),  # página de Safari (si la acción la acepta así)
    "{6, 1}": {"Type": "ExtensionInput"},   # la entrada tal cual, por si acaso
})

# 5. dirección de Haul + codificado
prefix = BASE.rstrip("/") + "/#add="
final = token_string(prefix + "￼", {"{%d, 1}" % len(prefix): ref(u_cod, "Codificado")})

actions = [
    action("is.workflow.actions.detect.text", UUID=u_texto, CustomOutputName="Texto", WFInput=ENTRADA),
    action("is.workflow.actions.detect.link", UUID=u_urls, CustomOutputName="URLs", WFInput=as_text({"Type": "ExtensionInput"})),
    action("is.workflow.actions.detect.link", UUID=u_urls2, CustomOutputName="URLs página", WFInput=ENTRADA),
    action("is.workflow.actions.gettext", UUID=u_bruto, WFTextActionText=bruto),
      # Entrada explícita y como texto (as_text): con la variable suelta
    # «Codificado» salía vacío y Haul recibía "#add=" a secas (15/11/2026).
    action("is.workflow.actions.urlencode", UUID=u_cod, CustomOutputName="Codificado", WFEncodeMode="Encode",
           WFInput=as_text(ref(u_bruto, "Texto"))),
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
