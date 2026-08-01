{{- define "pgbackup.name" -}}
{{ .Chart.Name }}
{{- end -}}

{{- define "pgbackup.fullname" -}}
{{ .Release.Name }}
{{- end -}}

{{- define "pgbackup.labels" -}}
app.kubernetes.io/name: {{ include "pgbackup.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
