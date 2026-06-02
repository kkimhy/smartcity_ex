(function () {
  const data = window.__SONGPA_LANDUSE_DATA__;
  if (!data) return;

  const FILTER_ALL = "ALL";

  const state = {
    layerMode: "parcel_use",
    selectedDong: FILTER_ALL,
    selectedUse: FILTER_ALL,
    searchTerm: "",
    selectedParcel: null,
    selectedOa: null,
    view: null,
    dragging: false,
    dragStart: null,
    renderFrame: null,
    searchDebounce: null,
    filterVersion: 0,
    filteredParcels: [],
    visibleParcels: [],
    visibleOa: [],
  };

  const canvas = document.getElementById("parcelCanvas");
  const ctx = canvas.getContext("2d");
  const layerModeEl = document.getElementById("layerMode");
  const dongFilterEl = document.getElementById("dongFilter");
  const useFilterEl = document.getElementById("useFilter");
  const searchInputEl = document.getElementById("searchInput");
  const resetViewBtn = document.getElementById("resetViewBtn");
  const mapStatusEl = document.getElementById("mapStatus");

  prepareFeatures(data.parcels);
  prepareFeatures(data.oaBoundaries);

  const parcelBounds = computeWorldBounds(data.parcels);
  const oaBounds = computeWorldBounds(data.oaBoundaries);
  const parcelIndex = createSpatialIndex(data.parcels);
  const oaIndex = createSpatialIndex(data.oaBoundaries);

  state.view = fitView(parcelBounds, canvas.width, canvas.height);

  populateSelect(
    dongFilterEl,
    [FILTER_ALL, ...uniqueSorted(data.parcels.map((feature) => feature.dongName).filter(Boolean))]
  );
  populateSelect(useFilterEl, [FILTER_ALL, ...data.parcelStats.useRows.map((row) => row.label)]);

  fillMeta();
  fillNotices();
  fillSummary();
  renderTables();
  updateUiText();
  recomputeFilteredParcels();
  bindEvents();
  renderAll();

  function bindEvents() {
    layerModeEl.addEventListener("change", () => {
      state.layerMode = layerModeEl.value;
      state.selectedParcel = null;
      state.selectedOa = null;
      if (state.layerMode === "oa_population" || state.layerMode === "oa_household") {
        useFilterEl.disabled = true;
        dongFilterEl.disabled = true;
        state.view = fitView(oaBounds, canvas.width, canvas.height);
      } else {
        useFilterEl.disabled = false;
        dongFilterEl.disabled = false;
        state.view = fitView(parcelBounds, canvas.width, canvas.height);
      }
      updateUiText();
      renderAll();
    });

    dongFilterEl.addEventListener("change", () => {
      state.selectedDong = dongFilterEl.value;
      state.selectedParcel = null;
      recomputeFilteredParcels();
      renderAll();
    });

    useFilterEl.addEventListener("change", () => {
      state.selectedUse = useFilterEl.value;
      state.selectedParcel = null;
      recomputeFilteredParcels();
      renderAll();
    });

    searchInputEl.addEventListener("input", () => {
      window.clearTimeout(state.searchDebounce);
      state.searchDebounce = window.setTimeout(() => {
        state.searchTerm = searchInputEl.value.trim().toLowerCase();
        state.selectedParcel = null;
        recomputeFilteredParcels();
        renderAll();
      }, 120);
    });

    resetViewBtn.addEventListener("click", () => {
      state.view = fitView(
        state.layerMode === "oa_population" || state.layerMode === "oa_household" ? oaBounds : parcelBounds,
        canvas.width,
        canvas.height
      );
      scheduleMapRender();
    });

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const zoomFactor = event.deltaY < 0 ? 1.16 : 0.86;
        const before = screenToWorld(event.offsetX, event.offsetY, state.view);
        state.view.scale *= zoomFactor;
        const after = screenToWorld(event.offsetX, event.offsetY, state.view);
        state.view.offsetX += (after.x - before.x) * state.view.scale;
        state.view.offsetY -= (after.y - before.y) * state.view.scale;
        scheduleMapRender();
      },
      { passive: false }
    );

    canvas.addEventListener("mousedown", (event) => {
      state.dragging = true;
      state.dragStart = {
        x: event.offsetX,
        y: event.offsetY,
        view: { ...state.view },
      };
    });

    window.addEventListener("mouseup", () => {
      state.dragging = false;
      state.dragStart = null;
    });

    canvas.addEventListener("mousemove", (event) => {
      if (!state.dragging || !state.dragStart) return;
      state.view.offsetX = state.dragStart.view.offsetX + (event.offsetX - state.dragStart.x);
      state.view.offsetY = state.dragStart.view.offsetY + (event.offsetY - state.dragStart.y);
      scheduleMapRender();
    });

    canvas.addEventListener("click", (event) => {
      const point = screenToWorld(event.offsetX, event.offsetY, state.view);
      if (state.layerMode === "oa_population" || state.layerMode === "oa_household") {
        state.selectedOa = pickFeature(point.x, point.y, oaIndex, null);
        state.selectedParcel = null;
      } else {
        state.selectedParcel = pickFeature(point.x, point.y, parcelIndex, featureMatchesCurrentFilter);
        state.selectedOa = null;
      }
      renderAll();
    });
  }

  function renderAll() {
    drawMap();
    fillLegend();
    fillParcelDetail();
    fillOaDetail();
    fillFilterSummary();
    drawPies();
    fillMapStatus();
  }

  function scheduleMapRender() {
    if (state.renderFrame) return;
    state.renderFrame = window.requestAnimationFrame(() => {
      state.renderFrame = null;
      drawMap();
      fillMapStatus();
    });
  }

  function prepareFeatures(features) {
    features.forEach((feature, index) => {
      feature._order = index;
      feature._searchText = [feature.pnu, feature.address, feature.dongName].filter(Boolean).join(" ").toLowerCase();
      feature._matchesFilter = true;
    });
  }

  function fillMeta() {
    document.getElementById("metaCard").innerHTML = `
      <dl>
        <dt>대상 지역</dt><dd>${data.meta.area}</dd>
        <dt>필지 기준일</dt><dd>${data.meta.dates.parcel}</dd>
        <dt>건물 GIS</dt><dd>${data.meta.dates.buildingGis}</dd>
        <dt>용도지역</dt><dd>${data.meta.dates.zoning}</dd>
        <dt>건축물대장</dt><dd>${data.meta.dates.buildingLedger}</dd>
        <dt>인구 통계</dt><dd>${data.meta.dates.census}</dd>
      </dl>
    `;
  }

  function fillNotices() {
    document.getElementById("noticeList").innerHTML = `
      <ul>${data.meta.notes.map((note) => `<li>${note}</li>`).join("")}</ul>
    `;
  }

  function fillSummary() {
    const stats = data.parcelStats.summary;
    const cards = [
      ["전체 필지", formatInt(stats.totalParcels), "송파구 전체 필지 기준"],
      [
        "건축 필지",
        formatInt(stats.buildingParcelCount),
        formatPercent(stats.buildingParcelCount / Math.max(stats.totalParcels, 1)),
      ],
      ["총 연면적", `${formatInt(stats.totalFloorArea)}㎡`, "필지별 건축 연면적 합계"],
      ["용도지역 수", formatInt(data.parcelStats.zoningRows.length), "대표 용도지역 분류"],
      ["총 인구", formatInt(data.census.summary.totalPopulation), "2024 집계구 기준"],
      [
        "총 가구",
        formatInt(data.census.summary.totalHouseholds),
        `가구당 ${data.census.summary.personsPerHousehold}명`,
      ],
    ];

    document.getElementById("summaryGrid").innerHTML = cards
      .map(
        ([title, value, note]) => `
          <article>
            <h3>${title}</h3>
            <strong>${value}</strong>
            <span>${note}</span>
          </article>
        `
      )
      .join("");
  }

  function renderTables() {
    renderTable(
      document.getElementById("useTable"),
      ["주용도", "필지 수", "비중", "연면적", "면적 비중", "세대/호수"],
      data.parcelStats.useRows.map((row) => [
        row.label,
        formatInt(row.parcelCount),
        `${row.parcelShare}%`,
        `${formatInt(row.floorArea)}㎡`,
        `${row.floorAreaShare}%`,
        formatInt(row.units || 0),
      ])
    );

    renderTable(
      document.getElementById("zoningTable"),
      ["용도지역", "필지 수", "비중", "연면적", "면적 비중"],
      data.parcelStats.zoningRows.map((row) => [
        row.label,
        formatInt(row.parcelCount),
        `${row.parcelShare}%`,
        `${formatInt(row.floorArea)}㎡`,
        `${row.floorAreaShare}%`,
      ])
    );

    renderTable(
      document.getElementById("dongTable"),
      ["행정동", "필지 수", "건축 필지", "연면적", "가구 수"],
      data.parcelStats.dongRows.map((row) => [
        row.label,
        formatInt(row.parcelCount),
        `${formatInt(row.buildingParcelCount)} (${row.buildingParcelShare}%)`,
        `${formatInt(row.floorArea)}㎡`,
        formatInt(row.households),
      ])
    );

    renderTable(
      document.getElementById("censusPopTable"),
      ["집계구 코드", "인구", "가구", "가구당 인원"],
      data.census.topPopulation.map((row) => [
        row.oaCode,
        formatInt(row.totalPopulation),
        formatInt(row.totalHouseholds),
        row.personsPerHousehold,
      ])
    );

    renderTable(
      document.getElementById("censusHouseholdTable"),
      ["집계구 코드", "가구", "인구", "가구당 인원"],
      data.census.topHouseholds.map((row) => [
        row.oaCode,
        formatInt(row.totalHouseholds),
        formatInt(row.totalPopulation),
        row.personsPerHousehold,
      ])
    );
  }

  function renderTable(tableEl, headers, rows) {
    tableEl.innerHTML = `
      <thead>
        <tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
          .join("")}
      </tbody>
    `;
  }

  function updateUiText() {
    const subtitles = {
      parcel_use: "필지 주용도 레이어",
      parcel_zoning: "필지 용도지역 레이어",
      oa_population: "집계구 인구 레이어",
      oa_household: "집계구 가구 레이어",
    };

    document.getElementById("mapSubtitle").textContent = subtitles[state.layerMode];
    document.getElementById("parcelPieTitle").textContent =
      state.layerMode === "parcel_zoning" ? "용도지역별 필지 비중" : "주용도별 필지 비중";
    document.getElementById("floorPieTitle").textContent =
      state.layerMode === "parcel_zoning" ? "용도지역별 연면적 비중" : "주용도별 연면적 비중";
  }

  function recomputeFilteredParcels() {
    const filtered = [];
    state.filterVersion += 1;

    data.parcels.forEach((feature) => {
      const match = featureMatchesCurrentFilter(feature);
      feature._matchesFilter = match;
      if (match) filtered.push(feature);
    });

    state.filteredParcels = filtered;
  }

  function featureMatchesCurrentFilter(feature) {
    const dongPass = state.selectedDong === FILTER_ALL || feature.dongName === state.selectedDong;
    const usePass = state.selectedUse === FILTER_ALL || feature.dominantUse === state.selectedUse;
    const searchPass = !state.searchTerm || feature._searchText.includes(state.searchTerm);
    return dongPass && usePass && searchPass;
  }

  function drawMap() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f5fafb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state.layerMode === "oa_population" || state.layerMode === "oa_household") {
      state.visibleOa = getVisibleFeatures(oaIndex, getViewportWorldBounds(state.view), null);
      state.visibleOa.forEach((feature) => drawOa(feature));
      if (state.selectedOa) drawOutline(state.selectedOa, "#111827", 2.2);
    } else {
      state.visibleParcels = getVisibleFeatures(
        parcelIndex,
        getViewportWorldBounds(state.view),
        featureMatchesCurrentFilter
      );
      state.visibleParcels.forEach((feature) => drawParcel(feature));
      if (state.selectedParcel) drawOutline(state.selectedParcel, "#111827", 2.2);
    }
  }

  function drawParcel(feature) {
    const palette = state.layerMode === "parcel_zoning" ? data.palette.zoning : data.palette.use;
    const key = state.layerMode === "parcel_zoning" ? feature.primaryZoning : feature.dominantUse;
    ctx.beginPath();
    traceRings(feature.rings);
    ctx.fillStyle = hexToRgba(palette[key] || "#c0c0c0", 0.84);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 0.4;
    ctx.fill("evenodd");
    ctx.stroke();
  }

  function drawOa(feature) {
    const isPopulation = state.layerMode === "oa_population";
    const value = isPopulation ? feature.totalPopulation : feature.totalHouseholds;
    const maxValue = isPopulation ? data.census.populationMax : data.census.householdMax;
    ctx.beginPath();
    traceRings(feature.rings);
    ctx.fillStyle = interpolateColor("#edf4f5", "#ff8b5e", maxValue ? value / maxValue : 0);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 0.5;
    ctx.fill("evenodd");
    ctx.stroke();
  }

  function drawOutline(feature, color, width) {
    ctx.save();
    ctx.beginPath();
    traceRings(feature.rings);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  function traceRings(rings) {
    rings.forEach((ring) => {
      for (let index = 0; index < ring.length; index += 2) {
        const point = worldToScreen(ring[index], ring[index + 1], state.view);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
    });
  }

  function fillLegend() {
    const legendEl = document.getElementById("legend");

    if (state.layerMode === "oa_population" || state.layerMode === "oa_household") {
      const maxValue = state.layerMode === "oa_population" ? data.census.populationMax : data.census.householdMax;
      legendEl.innerHTML = `
        <h4>${state.layerMode === "oa_population" ? "집계구 인구" : "집계구 가구"}</h4>
        <div class="gradient-bar" style="background:linear-gradient(90deg, #edf4f5 0%, #ff8b5e 100%);"></div>
        <div class="legend-scale"><span>0</span><span>${formatInt(maxValue)}</span></div>
      `;
      return;
    }

    const rows = state.layerMode === "parcel_zoning" ? data.parcelStats.zoningRows : data.parcelStats.useRows;
    const palette = state.layerMode === "parcel_zoning" ? data.palette.zoning : data.palette.use;
    legendEl.innerHTML = `
      <h4>${state.layerMode === "parcel_zoning" ? "용도지역 범례" : "주용도 범례"}</h4>
      <div class="legend-grid">
        ${rows
          .slice(0, 12)
          .map(
            (row) => `
              <div class="legend-item">
                <span class="legend-swatch" style="background:${palette[row.label] || "#b7b7b7"}"></span>
                <span>${row.label}</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function fillParcelDetail() {
    const target = document.getElementById("selectedParcel");
    const feature = state.selectedParcel;

    if (!feature) {
      target.innerHTML = `<p class="empty-state">필지 레이어에서 지도를 클릭하면 상세 정보를 보여줍니다.</p>`;
      return;
    }

    target.innerHTML = `
      <dl class="detail-grid">
        <dt>PNU</dt><dd>${feature.pnu}</dd>
        <dt>주소</dt><dd>${feature.address || "-"}</dd>
        <dt>행정동</dt><dd>${feature.dongName || "-"}</dd>
        <dt>지목</dt><dd>${feature.landCategory || "-"}</dd>
        <dt>주용도</dt><dd>${feature.dominantUse || "-"}</dd>
        <dt>용도지역</dt><dd>${feature.primaryZoning || "-"}</dd>
        <dt>용도 코드</dt><dd>${feature.zoningCode || "-"}</dd>
        <dt>연면적</dt><dd>${formatInt(feature.totalFloorArea)}㎡</dd>
        <dt>대장 건물 수</dt><dd>${formatInt(feature.ledgerBuildingCount)}</dd>
        <dt>GIS 건물 수</dt><dd>${formatInt(feature.gisBuildingCount)}</dd>
        <dt>세대/호수</dt><dd>${formatInt(feature.totalUnits)}</dd>
        <dt>가구 수</dt><dd>${formatInt(feature.totalHouseholds)}</dd>
      </dl>
    `;
  }

  function fillOaDetail() {
    const target = document.getElementById("selectedOa");
    const feature = state.selectedOa;

    if (!feature) {
      target.innerHTML = `<p class="empty-state">집계구 레이어에서 지도를 클릭하면 상세 정보를 보여줍니다.</p>`;
      return;
    }

    target.innerHTML = `
      <dl class="detail-grid">
        <dt>집계구 코드</dt><dd>${feature.oaCode}</dd>
        <dt>행정동 코드</dt><dd>${feature.admCd}</dd>
        <dt>인구</dt><dd>${formatInt(feature.totalPopulation)}</dd>
        <dt>가구</dt><dd>${formatInt(feature.totalHouseholds)}</dd>
        <dt>가구당 인원</dt><dd>${feature.personsPerHousehold}</dd>
      </dl>
    `;
  }

  function fillFilterSummary() {
    document.getElementById("filterSummary").innerHTML = `
      <dl class="detail-grid">
        <dt>필터 결과</dt><dd>${formatInt(state.filteredParcels.length)} 필지</dd>
        <dt>행정동</dt><dd>${state.selectedDong === FILTER_ALL ? "전체" : state.selectedDong}</dd>
        <dt>용도</dt><dd>${state.selectedUse === FILTER_ALL ? "전체" : state.selectedUse}</dd>
        <dt>검색어</dt><dd>${state.searchTerm || "-"}</dd>
      </dl>
    `;
  }

  function fillMapStatus() {
    if (state.layerMode === "oa_population" || state.layerMode === "oa_household") {
      mapStatusEl.innerHTML = `
        현재 표시: 집계구 ${formatInt(state.visibleOa.length)}개<br />
        안내: 확대 상태에서도 클릭 판별은 공간 인덱스로 처리해 응답을 줄였습니다.
      `;
      return;
    }

    mapStatusEl.innerHTML = `
      현재 표시: ${formatInt(state.visibleParcels.length)} / ${formatInt(state.filteredParcels.length)} 필지<br />
      안내: 화면 안에 들어오는 필지만 그리도록 바꿔서 이동과 확대가 더 빠르게 반응합니다.
    `;
  }

  function drawPies() {
    const rows = state.layerMode === "parcel_zoning" ? data.parcelStats.zoningRows : data.parcelStats.useRows;
    const palette = state.layerMode === "parcel_zoning" ? data.palette.zoning : data.palette.use;

    drawPie(
      document.getElementById("parcelPie"),
      rows.map((row) => ({
        label: row.label,
        value: row.parcelCount,
        color: palette[row.label] || "#b7b7b7",
      }))
    );

    drawPie(
      document.getElementById("floorPie"),
      rows.map((row) => ({
        label: row.label,
        value: row.floorArea,
        color: palette[row.label] || "#b7b7b7",
      }))
    );
  }

  function drawPie(canvasEl, rows) {
    const chart = canvasEl.getContext("2d");
    chart.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const topRows = rows.slice(0, 7);
    const otherValue = rows.slice(7).reduce((sum, row) => sum + row.value, 0);
    if (otherValue > 0) topRows.push({ label: "기타", value: otherValue, color: "#d4d4d4" });

    const total = topRows.reduce((sum, row) => sum + row.value, 0);
    const centerX = 104;
    const centerY = 118;
    const radius = 80;
    let start = -Math.PI / 2;

    topRows.forEach((row) => {
      const angle = total ? (row.value / total) * Math.PI * 2 : 0;
      chart.beginPath();
      chart.moveTo(centerX, centerY);
      chart.arc(centerX, centerY, radius, start, start + angle);
      chart.closePath();
      chart.fillStyle = row.color;
      chart.fill();
      start += angle;
    });

    chart.beginPath();
    chart.arc(centerX, centerY, 42, 0, Math.PI * 2);
    chart.fillStyle = "#ffffff";
    chart.fill();
  }

  function populateSelect(selectEl, values) {
    selectEl.innerHTML = values
      .map((value) => `<option value="${value}">${value === FILTER_ALL ? "전체" : value}</option>`)
      .join("");
  }

  function pickFeature(worldX, worldY, index, predicate) {
    const candidates = queryPointIndex(index, worldX, worldY).sort((a, b) => b._order - a._order);
    for (let i = 0; i < candidates.length; i += 1) {
      const feature = candidates[i];
      if (predicate && !predicate(feature)) continue;
      if (!bboxContains(feature.bbox, worldX, worldY)) continue;
      if (polygonContains(feature.rings, worldX, worldY)) return feature;
    }
    return null;
  }

  function getVisibleFeatures(index, bbox, predicate) {
    return queryBboxIndex(index, bbox)
      .filter((feature) => (!predicate || predicate(feature)) && intersectsBbox(feature.bbox, bbox))
      .sort((a, b) => a._order - b._order);
  }

  function createSpatialIndex(features) {
    const bounds = computeWorldBounds(features);
    const dimension = Math.min(96, Math.max(24, Math.round(Math.sqrt(Math.max(features.length, 1) / 12))));
    const cellWidth = (bounds.maxX - bounds.minX) / dimension || 1;
    const cellHeight = (bounds.maxY - bounds.minY) / dimension || 1;
    const buckets = Array.from({ length: dimension * dimension }, () => []);

    features.forEach((feature) => {
      const minCol = clamp(Math.floor((feature.bbox[0] - bounds.minX) / cellWidth), 0, dimension - 1);
      const maxCol = clamp(Math.floor((feature.bbox[2] - bounds.minX) / cellWidth), 0, dimension - 1);
      const minRow = clamp(Math.floor((feature.bbox[1] - bounds.minY) / cellHeight), 0, dimension - 1);
      const maxRow = clamp(Math.floor((feature.bbox[3] - bounds.minY) / cellHeight), 0, dimension - 1);

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          buckets[row * dimension + col].push(feature);
        }
      }
    });

    return { bounds, dimension, cellWidth, cellHeight, buckets };
  }

  function queryPointIndex(index, x, y) {
    if (!index || !bboxContains([index.bounds.minX, index.bounds.minY, index.bounds.maxX, index.bounds.maxY], x, y)) {
      return [];
    }
    const col = clamp(Math.floor((x - index.bounds.minX) / index.cellWidth), 0, index.dimension - 1);
    const row = clamp(Math.floor((y - index.bounds.minY) / index.cellHeight), 0, index.dimension - 1);
    return dedupeFeatures(index.buckets[row * index.dimension + col] || []);
  }

  function queryBboxIndex(index, bbox) {
    if (!intersectsBbox([index.bounds.minX, index.bounds.minY, index.bounds.maxX, index.bounds.maxY], bbox)) {
      return [];
    }
    const minCol = clamp(Math.floor((bbox[0] - index.bounds.minX) / index.cellWidth), 0, index.dimension - 1);
    const maxCol = clamp(Math.floor((bbox[2] - index.bounds.minX) / index.cellWidth), 0, index.dimension - 1);
    const minRow = clamp(Math.floor((bbox[1] - index.bounds.minY) / index.cellHeight), 0, index.dimension - 1);
    const maxRow = clamp(Math.floor((bbox[3] - index.bounds.minY) / index.cellHeight), 0, index.dimension - 1);
    const features = [];

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        features.push(...index.buckets[row * index.dimension + col]);
      }
    }

    return dedupeFeatures(features);
  }

  function dedupeFeatures(features) {
    const seen = new Set();
    const deduped = [];
    features.forEach((feature) => {
      if (seen.has(feature._order)) return;
      seen.add(feature._order);
      deduped.push(feature);
    });
    return deduped;
  }

  function getViewportWorldBounds(view) {
    const topLeft = screenToWorld(0, 0, view);
    const bottomRight = screenToWorld(canvas.width, canvas.height, view);
    return [
      Math.min(topLeft.x, bottomRight.x),
      Math.min(topLeft.y, bottomRight.y),
      Math.max(topLeft.x, bottomRight.x),
      Math.max(topLeft.y, bottomRight.y),
    ];
  }

  function bboxContains(bbox, x, y) {
    return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  }

  function intersectsBbox(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  function polygonContains(rings, x, y) {
    let inside = false;
    rings.forEach((ring) => {
      if (pointInRing(ring, x, y)) inside = !inside;
    });
    return inside;
  }

  function pointInRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; i += 2) {
      const xi = ring[i];
      const yi = ring[i + 1];
      const xj = ring[j];
      const yj = ring[j + 1];
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
      if (intersect) inside = !inside;
      j = i;
    }
    return inside;
  }

  function computeWorldBounds(features) {
    return features.reduce(
      (acc, feature) => ({
        minX: Math.min(acc.minX, feature.bbox[0]),
        minY: Math.min(acc.minY, feature.bbox[1]),
        maxX: Math.max(acc.maxX, feature.bbox[2]),
        maxY: Math.max(acc.maxY, feature.bbox[3]),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );
  }

  function fitView(bounds, width, height) {
    const padding = 36;
    const scale = Math.min(
      (width - padding * 2) / Math.max(bounds.maxX - bounds.minX, 1),
      (height - padding * 2) / Math.max(bounds.maxY - bounds.minY, 1)
    );
    return {
      scale,
      offsetX: padding - bounds.minX * scale,
      offsetY: height - padding + bounds.minY * scale,
    };
  }

  function worldToScreen(x, y, view) {
    return {
      x: x * view.scale + view.offsetX,
      y: view.offsetY - y * view.scale,
    };
  }

  function screenToWorld(x, y, view) {
    return {
      x: (x - view.offsetX) / view.scale,
      y: (view.offsetY - y) / view.scale,
    };
  }

  function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, "ko"));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hexToRgba(hex, alpha) {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function interpolateColor(startHex, endHex, ratio) {
    const start = parseHex(startHex);
    const end = parseHex(endHex);
    const clamped = Math.max(0, Math.min(1, ratio));
    const r = Math.round(start.r + (end.r - start.r) * clamped);
    const g = Math.round(start.g + (end.g - start.g) * clamped);
    const b = Math.round(start.b + (end.b - start.b) * clamped);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function parseHex(hex) {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  }

  function formatInt(value) {
    return Math.round(Number(value) || 0).toLocaleString("ko-KR");
  }

  function formatPercent(ratio) {
    return `${Math.round((ratio || 0) * 1000) / 10}%`;
  }
})();
