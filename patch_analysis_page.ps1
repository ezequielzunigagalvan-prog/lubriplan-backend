$target = "C:\Users\ferga\Documents\lubriplan-frontend\src\pages\AnalysisPage.jsx"
$content = Get-Content -Raw $target

$content = $content.Replace('if (level === "HIGH") return <Tag tone="red">Anomalía  Alta</Tag>;', 'if (level === "HIGH") return <Tag tone="red">Anomalia alta</Tag>;')
$content = $content.Replace('if (level === "MED") return <Tag tone="amber">Anomalía  Media</Tag>;', 'if (level === "MED") return <Tag tone="amber">Anomalia media</Tag>;')

$content = $content.Replace('if (!oilSummary?.trend) return "?";', 'if (!oilSummary?.trend) return "-";')
$content = $content.Replace('if (p == null) return `Î” ${formatByKind(d, "ACEITE")} (sin mes previo)`;', 'if (p == null) return `Cambio ${formatByKind(d, "ACEITE")} (sin base previa)`;')
$content = $content.Replace('return `${sign}${formatByKind(d, "ACEITE")} (${sign}${p.toFixed(1)}%)`;', 'return `Cambio ${sign}${formatByKind(d, "ACEITE")} (${sign}${p.toFixed(1)}%)`;')
$content = $content.Replace('if (!greaseSummary?.trend) return "?";', 'if (!greaseSummary?.trend) return "-";')
$content = $content.Replace('if (p == null) return `Î” ${formatByKind(d, "GRASA")} (sin mes previo)`;', 'if (p == null) return `Cambio ${formatByKind(d, "GRASA")} (sin base previa)`;')
$content = $content.Replace('return `${sign}${formatByKind(d, "GRASA")} (${sign}${p.toFixed(1)}%)`;', 'return `Cambio ${sign}${formatByKind(d, "GRASA")} (${sign}${p.toFixed(1)}%)`;')

$content = $content.Replace("Cargando análisis?", "Cargando analisis...")
$content = $content.Replace('title="Resumen"', 'title="Consumo y focos operativos"')
$content = $content.Replace('subtitle="Unidad base de análisis: litros-  (ej. bombazos), se muestra también."', 'subtitle="Unidad base: litros. Si existe captura operativa original, tambien se muestra."')
$content = $content.Replace('subtitle="Unidad base de análisis: g / kg. Si el backend envía captura original (ej. bombazos), se muestra también."', 'subtitle="Unidad base: gramos y kilos. Si existe captura operativa original, tambien se muestra."')
$content = $content.Replace("Lubricante más usado", "Lubricante foco")
$content = $content.Replace("Equipo con mayor consumo", "Equipo foco")
$content = $content.Replace("Tendencia mensual", "Cambio mensual")
$content = $content.Replace("*La señal de anomalía ya usa el motor predictivo real por equipo (ventanas 14d/90d y baseline). El ranking sigue siendo operativo por consumo del periodo.", "*La senal de anomalia ya usa el motor predictivo real por equipo. El ranking se mantiene operativo por consumo del periodo.")
$content = $content.Replace("*La senal de anomalía ya usa el motor predictivo real por equipo (ventanas 14d/90d y baseline). El ranking sigue siendo operativo por consumo del periodo.", "*La senal de anomalia ya usa el motor predictivo real por equipo. El ranking se mantiene operativo por consumo del periodo.")

$content = $content.Replace('title="Condición ? reportes y tendencias"', 'title="Condicion y confiabilidad"')
$content = $content.Replace('subtitle="Backlog, categorías, MTTR promedio y reincidencia. Listo para alimentar predicción."', 'subtitle="Backlog, origen del hallazgo, tiempos de atencion y reincidencia operativa."')
$content = $content.Replace('subtitle="Qu? est? ocurriendo (origen del problema)."', 'subtitle="Que esta ocurriendo y donde nace el hallazgo."')
$content = $content.Replace('title="MTTR promedio (horas) por Área"', 'title="Tiempo de atencion por area"')
$content = $content.Replace('title="Top equipos con más reportes"', 'title="Equipos foco"')
$content = $content.Replace('subtitle="Visión de dónde se concentra el riesgo."', 'subtitle="Donde se concentra la carga de reportes."')
$content = $content.Replace('subtitle="Equipos con 2+ reportes en el rango. Prioriza causa raíz."', 'subtitle="Equipos con dos o mas reportes en el rango."')

$pattern = '(?s)<div style=\{kpiGrid\}>.*?<div style=\{kpiLbl\}>Descartados</div>.*?</div>\s*</div>'
$replacement = @'
<div style={kpiGrid}>
                    <div className="lpCard" style={kpiCard}>
                      <div style={kpiTopBarDark} />
                      <div style={kpiLbl}>Reportes</div>
                      <div style={kpiVal}>{toNum(crData?.totals?.total)}</div>
                      <div style={kpiSub}>Hallazgos del rango</div>
                    </div>

                    <div className="lpCard" style={kpiCard}>
                      <div style={kpiTopBarDark} />
                      <div style={kpiLbl}>Activos</div>
                      <div style={kpiVal}>
                        {toNum(crData?.totals?.open) + toNum(crData?.totals?.inProgress)}
                      </div>
                      <div style={kpiSub}>
                        OPEN {toNum(crData?.totals?.open)} · EN PROCESO {toNum(crData?.totals?.inProgress)}
                      </div>
                    </div>

                    <div className="lpCard" style={kpiCard}>
                      <div style={kpiTopBarDark} />
                      <div style={kpiLbl}>Atendidos</div>
                      <div style={kpiVal}>
                        {toNum(crData?.totals?.resolved) + toNum(crData?.totals?.dismissed)}
                      </div>
                      <div style={kpiSub}>
                        Resueltos {toNum(crData?.totals?.resolved)} · Descartados {toNum(crData?.totals?.dismissed)}
                      </div>
                    </div>

                    <div className="lpCard" style={kpiCard}>
                      <div style={kpiTopBarDark} />
                      <div style={kpiLbl}>Area foco</div>
                      <div style={kpiVal}>{crData?.series?.mttrAvgHoursByArea?.labels?.[0] || "Sin area"}</div>
                      <div style={kpiSub}>
                        {crData?.series?.mttrAvgHoursByArea?.values?.length
                          ? `${toNum(crData?.series?.mttrAvgHoursByArea?.values?.[0]).toFixed(1)} h promedio`
                          : "Sin tiempo de atencion registrado"}
                      </div>
                    </div>
                  </div>
'@
$content = [regex]::Replace($content, $pattern, $replacement, 1)

[System.IO.File]::WriteAllText($target, $content, [System.Text.UTF8Encoding]::new($false))
