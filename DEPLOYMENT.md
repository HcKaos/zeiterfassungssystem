# Production Deployment Instructions


## Database Requirements
- Existing database schema is compatible
- Timer persistence uses existing NULL endZeit functionality
- No database migrations required

## Environment Variables Required
Create `.env` file with:
```
DB_HOST=your_mysql_host
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password
DB_NAME=zeiterfassung
SESSION_SECRET=generate-strong-random-secret-key
NODE_ENV=production
PORT=3000
FRONTEND_ORIGIN=https://your-domain.com
```

## Installation Steps
1. Extract project files to server
2. Install dependencies: `npm install`
3. Set up environment variables
4. Ensure MySQL database exists with correct schema
5. Start application: `npm start` or use process manager

## Security Configuration Checklist
- [ ] Generate strong SESSION_SECRET (min 32 random characters)
- [ ] Set NODE_ENV=production for secure cookies
- [ ] Configure HTTPS/SSL for production
- [ ] Set correct FRONTEND_ORIGIN for CORS
- [ ] Verify firewall settings (port 3000 or configured PORT)

## Testing After Deployment
1. Login functionality
2. Timer start/stop/persistence across browser sessions
3. Admin reports generation
4. Print functionality

## Critical Security Fixes Applied
- SQL injection prevention
- XSS protection with HTML escaping
- Session security improvements
- Race condition fixes in timer operations

## Support
Contact: Dan @Github
Date: 2025