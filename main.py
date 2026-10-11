from fastapi import FastAPI, Depends, Request, Form
from fastapi.templating import Jinja2Templates
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
import models
from database import engine, SessionLocal

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Exo PLM")
templates = Jinja2Templates(directory="templates")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/")
def read_root(request: Request, db: Session = Depends(get_db)):
    items = db.query(models.Item).all()
    
    # Calculate summary stats for the UI
    visible_lines = len(items)
    priced_sum = sum((item.unit_cost or 0) * item.qty for item in items if item.unit_cost)
    unpriced_lines = sum(1 for item in items if not item.unit_cost)

    return templates.TemplateResponse(
        request=request, 
        name="index.html", 
        context={
            "items": items,
            "visible_lines": visible_lines,
            "priced_sum": priced_sum,
            "unpriced_lines": unpriced_lines
        }
    )

@app.post("/items/add")
def add_item(
    item_id: str = Form(...),
    subsystem: str = Form(...),
    component_name: str = Form(...),
    purpose: str = Form(...),
    qty: int = Form(1),
    unit_cost: float = Form(0.0),
    supplier_link: str = Form(""),
    cost_basis: str = Form(...),
    stage: str = Form("Baseline"),
    db: Session = Depends(get_db)
):
    new_item = models.Item(
        item_id=item_id,
        subsystem=subsystem,
        component_name=component_name,
        purpose=purpose,
        qty=qty,
        unit_cost=unit_cost if unit_cost > 0 else None,
        supplier_link=supplier_link,
        cost_basis=cost_basis,
        stage=stage
    )
    db.add(new_item)
    db.commit()
    
    return RedirectResponse(url="/", status_code=303)