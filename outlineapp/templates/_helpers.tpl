{{- define "outlineapp.name" -}}
{{ .Chart.Name }}
{{- end -}}

{{- define "outlineapp.fullname" -}}
{{ .Release.Name }}
{{- end -}}

{{- define "outlineapp.labels" -}}
app.kubernetes.io/name: {{ include "outlineapp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
