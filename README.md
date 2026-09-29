# Lista por invitación

Página para un boliche exclusivo: para entrar hay que saber el código, que circula de boca en boca.
Con el código correcto se ve la próxima fiesta y te podés anotar en lista. Al anotarte recibís un pase
con tu código de ingreso y recién ahí se revela la dirección.

## Qué incluye

**La puerta** (`/`)
- Pantalla oscura con el logo manuscrito, el texto de bienvenida y el campo "Escribí el código".
- El código se verifica en el servidor: nunca aparece en el código de la página.
- Límite de 8 intentos cada 15 minutos por conexión, para que no se pueda adivinar probando.
- El acceso dura 6 horas en ese teléfono.

**La lista**
- Nombre y apellido, DNI, fecha de nacimiento, celular, Instagram y acompañantes (hasta +3).
- Controla la edad mínima el día de la fiesta, que no se repita el DNI y el cupo de la lista.
- El pase queda guardado en el teléfono: si vuelve a entrar, lo ve directamente.

**El panel** (`/admin`)
- **Lista:** buscador por nombre, DNI o código de ingreso, botón "Marcar ingreso" para usar en la puerta,
  totales de anotados, personas e ingresos, y exportar a CSV (Excel).
- **Fiestas:** crear y editar fechas, cupo, descripción y dirección, y abrir o cerrar la lista.
- **Códigos:** varios códigos a la vez (por ejemplo uno por RRPP), con límite de usos opcional.
  Muestra cuántas personas se anotaron con cada uno. Pausar un código corta el acceso de quienes entraron con él.
- **Ajustes:** nombre del lugar, textos de la puerta, Instagram y edad mínima.

## Probarlo en tu computadora

Necesitás [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm start
```

- Puerta: http://localhost:3000 — código inicial `MEDIANOCHE`
- Panel: http://localhost:3000/admin — contraseña `admin123`

**Antes de publicarlo cambiá la contraseña** con la variable `ADMIN_PASSWORD`.

Pruebas automáticas: `npm test`.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `ADMIN_PASSWORD` | Contraseña del panel. |
| `INITIAL_CODE` | Primer código de acceso (solo se usa la primera vez; después se manejan desde el panel). |
| `CLUB_NAME` | Nombre inicial del lugar (se puede cambiar en Ajustes). |
| `SESSION_SECRET` | Clave para firmar los accesos (opcional; si no está, se genera una). |
| `DATA_DIR` | Carpeta donde se guarda la lista (por defecto `./data`). |
| `PORT` | Puerto (Railway lo pone solo). |

## Publicarlo en Railway

1. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** y elegí este repositorio.
2. **Para no perder la lista:** en el servicio creá un **Volume** montado en `/data` y agregá la variable `DATA_DIR=/data`.
   Sin eso, cada nueva versión borra las fiestas, los códigos y la lista.
3. En **Variables** agregá `ADMIN_PASSWORD` (y si querés `INITIAL_CODE` y `CLUB_NAME`).
4. En **Settings → Networking → Generate Domain** obtenés la dirección pública.

## Estructura

```
server.js           Servidor y API (código, lista y panel)
db.js               Datos en un archivo JSON (data/db.json)
public/
  index.html        La puerta, el formulario y el pase
  club.js           Lógica de la puerta
  admin.html        Panel
  admin.js          Lógica del panel
  club.css          Estilos
  common.js         Funciones compartidas
test/api.test.js    Pruebas
```
