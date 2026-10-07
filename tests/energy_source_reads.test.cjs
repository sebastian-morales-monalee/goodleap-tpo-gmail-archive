const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const project='d2d4ad7b-0b27-4dbc-a315-86511e7f0835';
const org='b01792e6-ee4e-401c-afa0-84d9d7154c76';
const panelIds=[0,1,2].map(i=>`a2d4ad7b-0b27-4dbc-a315-86511e7f083${i}`);
function context(){const c=vm.createContext({console});
  for(const file of ['EnergyProductionMetrics.gs','ProjectIdSummary.gs'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),c);
  c.postHogStringLiteral_=s=>`'${s}'`;return c;}
function response(rows){const columns=Object.keys(rows[0]||{});
  return {columns,results:rows.map(row=>columns.map(col=>row[col]))};}
const p={project_id:project,organization_id:org,energy_data_source:'current-project-live-panels',
  project_active_panel_count:3,panel_rated_power_w:430,production_engine_version:'3',production_derate_percentage:0,
  selected_inverter_json:'{}',annual_energy_use_ackwh:1000};
const version={project_id:project,organization_id:org,snapshot_version_id:'latest',snapshot_date:'2026-10-05T10:00:00Z',
  snapshot_engine_version:'2',active_panel_ids:panelIds,
  solar_panels:JSON.stringify(panelIds.map(id=>({id,isActive:true,panelAnnualProdDckwh:999})))};
const panels=panelIds.map((id,i)=>({id,project_id:project,organization_id:org,is_active:true,
  panel_annual_prod_dckwh:(i+1)*10,diurnal_dc_shape:'[]',updated_at:`2026-10-0${i+1}T10:00:00Z`}));
test('staged reads use current production, not the historic JSON, and avoid warehouse panel joins',()=>{
  const c=context(),queries=[],answers=[response([p]),response([version]),response(panels)];
  c.executePostHogHogQL_=sql=>{queries.push(sql);return answers.shift();};
  const rows=c.projectEnergyResponseObjects_(c.readProjectEnergySourceRows_([project],'goodleap_postgres_projects','test'));
  assert.equal(rows[0].active_panel_count,3);assert.equal(rows[0].reference_dc_production_kwh,60);
  assert.equal(rows[0].expected_panel_count,3);assert.equal(rows[0].unique_panel_count,3);
  assert.equal(rows[0].snapshot_version_id,'latest');assert.equal(rows[0].snapshot_engine_version,'2');
  assert.equal(rows[0].panels_updated_at,panels[2].updated_at);
  assert.equal(queries.length,3);
  assert.ok(!queries[0].includes('projectversions'));assert.ok(!queries[0].includes('solarpanels'));
  assert.match(queries[1],/argMax/);assert.ok(!queries[1].includes('JOIN'));
  assert.match(queries[2],/AND id IN/);assert.ok(!queries[2].includes('JOIN'));
});
test('exact organization/project keys and duplicate records cannot contribute arbitrary DC',()=>{
  for(const bad of [[...panels.slice(0,2),{...panels[2],organization_id:'other'}],
    [...panels,{...panels[2],panel_annual_prod_dckwh:10000}]]){
    const c=context(),answers=[response([p]),response([version]),response(bad)];
    c.executePostHogHogQL_=()=>answers.shift();
    const row=c.projectEnergyResponseObjects_(c.readProjectEnergySourceRows_([project],'goodleap_postgres_projects','test'))[0];
    assert.equal(row.active_panel_count,2);assert.equal(row.panels_missing_production,1);
    assert.equal(row.reference_dc_production_kwh,30);
  }
});
test('empty or missing membership avoids unbounded panel queries and preserves zero-count metadata',()=>{
  for(const versions of [[],[{...version,active_panel_ids:[]}]]){
    const c=context(),answers=[response([p]),response(versions)];let calls=0;
    c.executePostHogHogQL_=()=>{calls++;return answers.shift();};
    const row=c.projectEnergyResponseObjects_(c.readProjectEnergySourceRows_([project],'goodleap_postgres_projects','test'))[0];
    assert.equal(calls,2);assert.equal(row.expected_panel_count,0);assert.equal(row.active_panel_count,0);
    assert.equal(row.reference_dc_production_kwh,0);
  }
});
