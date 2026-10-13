const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({console});
for (const name of ['EnergyProductionMetrics.gs', 'ProjectIdSummary.gs'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), ctx);
const models = [3800,5760,7600,10000,11400].map((power,i)=>({
  id:`model-${i}`,model:`SolarEdge (${power} W)`,nominalACPowerOutputW:power,
  maxEfficiencyPercentage:99.2,minSystemSizeKw:[0,5.13,7.695,10.26,13.5][i],
  maxSystemSizeKw:[5.13,7.695,10.26,13.5,15.39][i],
}));
const source = {
  dataSource:'current-project-live-panels',activePanelCount:11,projectActivePanelCount:11,
  expectedPanelCount:11,uniquePanelCount:11,panelRatedPowerW:430,
  referenceDcProductionKwh:4496.994270587058,selectedInverterJson:JSON.stringify({models}),
  inverterType:'string',panelsMissingProduction:0,panelsWithDiurnalShape:0,
  productionDeratePercent:0,annualEnergyUseAcKwh:18642,productionEngineVersion:'3',
};
test('current project reproduces independently verified SolarEdge example',()=>{
  const m=ctx.calculateProjectEnergyMetrics_(source);
  assert.equal(m.systemSizeKw,4.73); assert.equal(m.inverterNominalAcPowerW,3800);
  assert.equal(m.inverterCount,1); assert.equal(m.inverterMaxEfficiencyPercent,99.2);
  assert.ok(Math.abs(m.estimatedAnnualAcProductionKwh-4794.004571914672)<1e-8);
  assert.ok(Math.abs(m.estimatedOffsetPercent-25.716149404112603)<1e-9);
  const rules=ctx.goodLeapConditionalLookup_(ctx.defaultGoodLeapConditionalRows_());
  const cells=Array.from(ctx.projectIdSummaryConditionalCells_(m,'PA',rules));
  assert.ok(Math.abs(cells[0]-1013.5316219692752)<1e-8);
  assert.deepEqual(cells.slice(1),[true,true,false]);
});
test('unique range uses exclusive lower/inclusive upper limits; override has priority',()=>{
  const json=JSON.stringify({models});
  assert.equal(ctx.projectEnergySelectedInverterModel_(json,null,5.13).model.id,'model-0');
  assert.equal(ctx.projectEnergySelectedInverterModel_(json,null,5.13001).model.id,'model-1');
  assert.equal(ctx.projectEnergySelectedInverterModel_(json,'model-2',4.73).model.id,'model-2');
  assert.equal(ctx.projectEnergySelectedInverterModel_(json,'missing',4.73),null);
  assert.equal(ctx.projectEnergySelectedInverterModel_(json,null,16),null);
  assert.equal(ctx.projectEnergySelectedInverterModel_(JSON.stringify({models:[models[0],
    {...models[1],minSystemSizeKw:0}]}),null,4.73),null);
});
test('duplicate identical physical bands resolve, conflicting specs do not',()=>{
  assert.ok(ctx.projectEnergySelectedInverterModel_(JSON.stringify({models:[models[0],models[0]]}),null,4.73));
  assert.equal(ctx.projectEnergySelectedInverterModel_(JSON.stringify({models:[models[0],
    {...models[0],maxEfficiencyPercentage:97}]}),null,4.73),null);
  assert.ok(ctx.projectEnergySelectedInverterModel_(JSON.stringify({models:[{
    model:'Micro',minSystemSizeKw:0,maxSystemSizeKw:0}]}),null,8));
});
test('catalogue name fallback distinguishes repeated watt suffix and same name variants',()=>{
  const selected={model:{id:'pricing-id',model:'SolarEdge (3800W) (3800 W)',nominalACPowerOutputW:3800}};
  const catalog=[3800,5760].map(power=>({id:`canonical-${power}`,model_number:'SolarEdge',
    nominal_ac_power_output_w:power,count_strategy:'string'}));
  assert.equal(ctx.projectEnergyResolveCatalogModel_(selected,catalog).id,'canonical-3800');
});
test('incomplete, duplicate or missing membership never produces partial DC/AC totals',()=>{
  for(const change of [{activePanelCount:10},{expectedPanelCount:10},{uniquePanelCount:10},
    {panelsMissingProduction:1}]) {
    const m=ctx.calculateProjectEnergyMetrics_({...source,...change});
    assert.equal(m.systemSizeKw,4.73);assert.equal(m.referenceDcProductionKwh,null);
    assert.equal(m.estimatedAnnualAcProductionKwh,null);assert.equal(m.estimatedOffsetPercent,null);
    assert.match(m.energyCalculationStatus,/incomplete|mismatch/);
  }
});
test('string and micro quantities honor only positive integer overrides',()=>{
  for(const type of ['string','micro']) {
    assert.equal(ctx.calculateProjectEnergyMetrics_({...source,inverterType:type,inverterCountOverride:2}).inverterCount,2);
    for(const value of [0,-1,1.5]) assert.equal(ctx.calculateProjectEnergyMetrics_({
      ...source,inverterType:type,inverterCountOverride:value}).inverterCount,null);
  }
});
test('unsupported engine inputs remain explicitly unresolved',()=>{
  for(const change of [{productionDeratePercent:null},{productionDeratePercent:1},
    {panelsWithDiurnalShape:1},{productionEngineVersion:'1'}])
    assert.equal(ctx.calculateProjectEnergyMetrics_({...source,...change}).estimatedAnnualAcProductionKwh,null);
});
test('ambiguous pricing selection cannot be replaced by disconnected catalogue numbers',()=>{
  const m=ctx.calculateProjectEnergyMetrics_({...source,
    selectedInverterJson:JSON.stringify({models:[models[0],{...models[0],id:'other'}]}),
    catalogNominalAcPowerW:3800,catalogEfficiencyPercent:99.2});
  assert.equal(m.estimatedAnnualAcProductionKwh,null);
  assert.match(m.energyCalculationStatus,/ambiguous selected inverter model/);
});
test('offset keeps precision for 110/150 boundaries',()=>{
  const ac=ctx.calculateProjectEnergyMetrics_(source).estimatedAnnualAcProductionKwh;
  const rules=ctx.goodLeapConditionalLookup_(ctx.defaultGoodLeapConditionalRows_());
  for(const [offset,expected] of [[110.001,[false,true]],[150.001,[false,false]]]) {
    const m=ctx.calculateProjectEnergyMetrics_({...source,annualEnergyUseAcKwh:ac*100/offset});
    assert.deepEqual(Array.from(ctx.projectIdSummaryConditionalCells_(m,'PA',rules)).slice(2),expected);
  }
});
test('energy queries use small independent batches in both sources',()=>{
  ctx.readProjectEnergySourceRows_=(ids,table,name)=>ctx.executePostHogHogQL_(
    ctx.buildProjectIdSummaryEnergyQuery_(ids,table),name);
  const ids=Array.from({length:6},(_,i)=>`d2d4ad7b-0b27-4dbc-a315-86511e7f083${i}`);
  const sizes=[],queries=[];
  ctx.postHogStringLiteral_=v=>`'${v}'`;
  ctx.getPostHogSolarSettings_=()=>({goodLeapProjectsTable:'goodleap_postgres_projects',
    artemisSalesProjectsTable:'artemis_sales_postgres_projects'});
  ctx.chunkPostHogArray_=(items,size)=>{sizes.push(size);const out=[];
    for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size));return out;};
  ctx.executePostHogHogQL_=sql=>{queries.push(sql);return {columns:['project_id'],results:[]};};
  assert.equal(ctx.fetchProjectIdSummaryEnergyMetrics_(ids).size,6);
  assert.deepEqual(sizes,[5,5]);assert.equal(queries.length,4);
  for(const query of queries) assert.ok(query.match(/WHERE p.id IN \(([^)]*)\)/)[1].split(',').length<=5);
});
test('a failed batch retries IDs individually in the same source before publication',()=>{
  const ids=['d2d4ad7b-0b27-4dbc-a315-86511e7f0835','d2d4ad7b-0b27-4dbc-a315-86511e7f0834'];
  let large=0,single=0;
  ctx.executePostHogHogQL_=sql=>{
    if(sql.includes('invertermodels')) return {columns:['id','model_number','count_strategy',
      'nominal_ac_power_output_w','max_efficiency_percentage'],results:[['canonical','SolarEdge','string',3800,99.2]]};
    assert.ok(sql.includes('FROM goodleap_postgres_projects AS p'));
    const found=sql.match(/WHERE p.id IN \(([^)]*)\)/)[1].split(',').map(s=>s.trim().replaceAll("'",''));
    if(found.length>1){large++;throw Error('504');} single++;
    const row={project_id:found[0],energy_data_source:source.dataSource,
      active_panel_count:11,project_active_panel_count:11,expected_panel_count:11,unique_panel_count:11,
      panel_rated_power_w:430,reference_dc_production_kwh:source.referenceDcProductionKwh,
      selected_inverter_json:source.selectedInverterJson,panels_missing_production:0,
      panels_with_diurnal_shape:0,annual_energy_use_ackwh:18642,production_engine_version:'3',
      production_derate_percentage:0};
    return {columns:Object.keys(row),results:[Object.values(row)]};
  };
  const result=ctx.fetchProjectIdSummaryEnergyMetrics_(ids);
  assert.equal(large,1);assert.equal(single,2);
  for(const id of ids) assert.ok(result.get(id).estimatedAnnualAcProductionKwh>4794);
});
test('persistent source failures abort rather than publish partial results or use Sales',()=>{
  const sources=[];
  ctx.executePostHogHogQL_=sql=>{sources.push(sql);throw Error('504');};
  assert.throws(()=>ctx.fetchProjectIdSummaryEnergyMetrics_([
    'd2d4ad7b-0b27-4dbc-a315-86511e7f0835','d2d4ad7b-0b27-4dbc-a315-86511e7f0834']),/refresh aborted/);
  assert.equal(sources.length,3);
  assert.ok(sources.every(s=>!s.includes('artemis_sales')));
});
test('catalogue reads are shared across batches but not across refreshes',()=>{
  const ids=Array.from({length:6},(_,i)=>`d2d4ad7b-0b27-4dbc-a315-86511e7f083${i}`);
  let catalogCalls=0;
  ctx.readProjectEnergySourceRows_=batch=>{
    const rows=batch.map(id=>({project_id:id,energy_data_source:source.dataSource,
      active_panel_count:11,project_active_panel_count:11,expected_panel_count:11,unique_panel_count:11,
      panel_rated_power_w:430,reference_dc_production_kwh:source.referenceDcProductionKwh,
      selected_inverter_json:source.selectedInverterJson,panels_missing_production:0,
      panels_with_diurnal_shape:0,annual_energy_use_ackwh:18642,production_engine_version:'3',production_derate_percentage:0}));
    const columns=Object.keys(rows[0]);return {columns,results:rows.map(row=>columns.map(k=>row[k]))};
  };
  ctx.executePostHogHogQL_=sql=>{assert.match(sql,/invertermodels/);catalogCalls++;
    return {columns:['id','model_number','count_strategy','nominal_ac_power_output_w','max_efficiency_percentage'],
      results:[['canonical','SolarEdge','string',3800,99.2]]};};
  assert.equal(ctx.fetchProjectIdSummaryEnergyMetrics_(ids).size,6);assert.equal(catalogCalls,1);
  assert.equal(ctx.fetchProjectIdSummaryEnergyMetrics_(ids).size,6);assert.equal(catalogCalls,2);
});
